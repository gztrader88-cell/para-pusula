// gurbuzguler.com — bağımlılıksız Node sunucusu
// public/ klasörünü yayınlar, /api/mesaj'a gelen formları data/mesajlar.jsonl dosyasına yazar.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8799;
const ADMIN_ANAHTAR = process.env.ADMIN_ANAHTAR || '';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'mesajlar.jsonl');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml'
};

const sonIstekler = new Map(); // ip -> zaman damgaları (basit hız sınırı)

// Sayaç: bağlantı sayfasına kaç kişi geldi, hangi düğmeye kaç kez basıldı.
// Kişi bilgisi tutulmaz; yalnız gün, giriş (ana ya da nasdaq), Instagram içi olup olmadığı ve olay adı sayılır.
const SAYAC_FILE = path.join(DATA_DIR, 'sayac.json');
const SAYAC_ANAHTAR = process.env.SAYAC_ANAHTAR || 'gg-sayac-7k2m9q4x';
const SAYAC_OLAYLAR = new Set(['gor', 'abone', 'ios', 'android', 'bist', 'abd', 'transis']);
const sayacIstekler = new Map();
let sayac = {};
try { sayac = JSON.parse(fs.readFileSync(SAYAC_FILE, 'utf8')); } catch {}
let sayacKirli = false;
setInterval(() => {
  if (!sayacKirli) return;
  sayacKirli = false;
  fs.mkdir(DATA_DIR, { recursive: true }, () => fs.writeFile(SAYAC_FILE, JSON.stringify(sayac), () => {}));
}, 10000).unref();

function sayAl(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const simdi = Date.now();
  const liste = (sayacIstekler.get(ip) || []).filter(t => simdi - t < 10 * 60 * 1000);
  liste.push(simdi);
  sayacIstekler.set(ip, liste);
  if (sayacIstekler.size > 5000) sayacIstekler.clear();
  let govde = '';
  req.on('data', c => { govde += c; if (govde.length > 500) req.destroy(); });
  req.on('end', () => {
    res.writeHead(204); res.end();
    if (liste.length > 40) return; // aynı adresten aşırı istek sayılmaz
    if (/bot|crawl|spider|facebookexternalhit|preview/i.test(req.headers['user-agent'] || '')) return;
    let veri;
    try { veri = JSON.parse(govde); } catch { return; }
    if (!veri || !SAYAC_OLAYLAR.has(veri.o)) return;
    const gun = new Date(simdi + 3 * 3600 * 1000).toISOString().slice(0, 10); // Türkiye saatiyle gün
    const anahtar = (veri.s === 'nasdaq' ? 'nasdaq' : 'ana') + '.' + (veri.ig ? 'ig' : 'dis') + '.' + veri.o;
    if (!sayac[gun]) sayac[gun] = {};
    sayac[gun][anahtar] = (sayac[gun][anahtar] || 0) + 1;
    sayacKirli = true;
  });
}

function sayacOku(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('anahtar') !== SAYAC_ANAHTAR) return html(res, 403, 'Yetkisiz');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ okuma: new Date().toISOString(), gunler: sayac }));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || /^\/nasdaq\/?$/i.test(p)) p = '/index.html'; // /nasdaq aynı sayfayı Nasdaq hesabından gelene göre gösterir
  if (!path.extname(p)) p += '.html'; // /hakkimda → hakkimda.html
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return html(res, 403, 'Yasak');
  fs.readFile(file, (err, data) => {
    // Kaldırılan sayfalara (eğitim, ön kayıt vb.) gelen eski bağlantılar ana sayfaya döner.
    if (err && path.extname(file).toLowerCase() === '.html') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (err) return html(res, 404,'<!doctype html><meta charset="utf-8"><title>Sayfa bulunamadı</title><p style="font-family:sans-serif;padding:40px">Sayfa bulunamadı. <a href="/">Ana sayfa</a></p>');
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext !== '.html') headers['Cache-Control'] = 'public, max-age=86400';
    else headers['Cache-Control'] = 'no-cache'; // sayfa değişiklikleri telefonda hemen görünsün
    res.writeHead(200, headers);
    res.end(data);
  });
}

function hizSiniri(ip) {
  const simdi = Date.now();
  const liste = (sonIstekler.get(ip) || []).filter(t => simdi - t < 10 * 60 * 1000);
  liste.push(simdi);
  sonIstekler.set(ip, liste);
  return liste.length > 10;
}

function mesajAl(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (hizSiniri(ip)) return json(res, 429, { hata: 'Çok fazla istek' });
  let govde = '';
  req.on('data', c => { govde += c; if (govde.length > 20000) req.destroy(); });
  req.on('end', () => {
    let veri;
    try { veri = JSON.parse(govde); } catch { return json(res, 400, { hata: 'Geçersiz veri' }); }
    if (veri.site) return json(res, 200, { ok: true }); // bot tuzağı doluysa sessizce yoksay
    const ad = String(veri.ad || '').trim().slice(0, 120);
    const eposta = String(veri.eposta || '').trim().slice(0, 160);
    if (!ad || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(eposta)) return json(res, 400, { hata: 'Ad ve geçerli e-posta gerekli' });
    const kayit = {
      zaman: new Date().toISOString(),
      tur: veri.tur === 'iletisim' ? 'iletisim' : 'onkayit',
      ad, eposta,
      telefon: String(veri.telefon || '').trim().slice(0, 40),
      seviye: String(veri.seviye || '').trim().slice(0, 40),
      mesaj: String(veri.mesaj || '').trim().slice(0, 2000),
      ip
    };
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.appendFile(DATA_FILE, JSON.stringify(kayit) + '\n', err => {
        if (err) { console.error('yazma hatası', err); return json(res, 500, { hata: 'Kaydedilemedi' }); }
        console.log('MESAJ', kayit.tur, kayit.eposta);
        json(res, 200, { ok: true });
      });
    });
  });
}

function yonetim(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!ADMIN_ANAHTAR || u.searchParams.get('anahtar') !== ADMIN_ANAHTAR) return html(res, 403, 'Yetkisiz');
  let satirlar = [];
  try { satirlar = fs.readFileSync(DATA_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  satirlar.reverse();
  const rows = satirlar.map(k => `<tr><td>${esc(k.zaman.replace('T', ' ').slice(0, 16))}</td><td>${esc(k.tur)}</td><td>${esc(k.ad)}</td><td>${esc(k.eposta)}</td><td>${esc(k.telefon)}</td><td>${esc(k.seviye)}</td><td>${esc(k.mesaj)}</td></tr>`).join('');
  html(res, 200, `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Mesajlar</title>
<style>body{font-family:system-ui;padding:24px;background:#f5f7fa;color:#0f1a2e}table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #dde3ec;padding:8px;text-align:left;vertical-align:top;font-size:14px}th{background:#0f2a5f;color:#fff}</style>
<h1>Mesajlar ve ön kayıtlar (${satirlar.length})</h1>
<p><a href="/yonetim.csv?anahtar=${encodeURIComponent(ADMIN_ANAHTAR)}">CSV indir</a></p>
<table><tr><th>Zaman</th><th>Tür</th><th>Ad</th><th>E-posta</th><th>Telefon</th><th>Seviye</th><th>Mesaj</th></tr>${rows}</table></html>`);
}

function yonetimCsv(req, res) {
  const u = new URL(req.url, 'http://x');
  if (!ADMIN_ANAHTAR || u.searchParams.get('anahtar') !== ADMIN_ANAHTAR) return html(res, 403, 'Yetkisiz');
  let satirlar = [];
  try { satirlar = fs.readFileSync(DATA_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const q = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  const csv = ['zaman;tur;ad;eposta;telefon;seviye;mesaj'].concat(satirlar.map(k => [k.zaman, k.tur, k.ad, k.eposta, k.telefon, k.seviye, k.mesaj].map(q).join(';'))).join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mesajlar.csv"' });
  res.end('﻿' + csv);
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && p === '/api/mesaj') return mesajAl(req, res);
  if (req.method === 'POST' && p === '/api/say') return sayAl(req, res);
  if (req.method === 'GET' && p === '/api/sayac') return sayacOku(req, res);
  if (req.method === 'GET' && p === '/yonetim') return yonetim(req, res);
  if (req.method === 'GET' && p === '/yonetim.csv') return yonetimCsv(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  html(res, 405, 'Yöntem desteklenmiyor');
}).listen(PORT, () => console.log('gurbuzguler.com sunucusu ' + PORT + ' portunda'));
