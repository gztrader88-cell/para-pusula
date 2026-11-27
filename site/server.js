// gurbuzguler.com — bağımlılıksız Node sunucusu
// public/ klasörünü yayınlar, /api/mesaj'a gelen formları data/mesajlar.jsonl dosyasına yazar.
'use strict';
const http = require('http');
const https = require('https');
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
const SAYAC_OLAYLAR = new Set(['gor', 'abone', 'ios', 'android', 'bist', 'abd', 'transis', 'facebook', 'tiktok', 'robot', 'basvuru']);
const SAYAC_GIRISLER = new Set(['ana', 'nasdaq', 'facebook', 'tiktok']);
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
    const anahtar = (SAYAC_GIRISLER.has(veri.s) ? veri.s : 'ana') + '.' + (veri.ig ? 'ig' : 'dis') + '.' + veri.o;
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
  // /nasdaq, /facebook ve /tiktok aynı sayfayı, kişinin geldiği hesaba göre gösterir
  if (p === '/' || /^\/(nasdaq|facebook|tiktok)\/?$/i.test(p)) p = '/index.html';
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

// ── Robot bölümü ──
// Başvuru: ad, soyad, telefon ve yaklaşık sermaye Telegram'a mesaj olarak gider.
// Bot anahtarı ve sohbet kimliği yalnız ortam değişkeninde durur, koda yazılmaz.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const BASVURU_FILE = path.join(DATA_DIR, 'robot-basvurular.jsonl');
const SERMAYELER = { '1': '500 bin TL altı', '2': '500 bin – 1 milyon TL', '3': '1 – 3 milyon TL', '4': '3 milyon TL üstü' };
const KAYNAKLAR = new Set(['ana', 'nasdaq', 'facebook', 'tiktok']);
const basvuruIstekler = new Map();

function telegramGonder(metin) {
  return new Promise((coz, ret) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return ret(new Error('Telegram ayarı yok'));
    const u = new URL(TELEGRAM_API + '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage');
    const govde = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: metin, disable_web_page_preview: true });
    const istek = (u.protocol === 'http:' ? http : https).request(u, {
      method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(govde) }
    }, r => {
      let c = ''; r.on('data', d => { c += d; });
      r.on('end', () => (r.statusCode === 200 ? coz() : ret(new Error('Telegram ' + r.statusCode))));
    });
    istek.on('timeout', () => istek.destroy(new Error('Telegram zaman aşımı')));
    istek.on('error', ret);
    istek.end(govde);
  });
}

function basvuruAl(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const simdi = Date.now();
  const liste = (basvuruIstekler.get(ip) || []).filter(t => simdi - t < 60 * 60 * 1000);
  if (liste.length >= 5) return json(res, 429, { hata: 'Çok fazla deneme yapıldı. Lütfen bir süre sonra yeniden deneyin.' });
  let govde = '';
  req.on('data', c => { govde += c; if (govde.length > 4000) req.destroy(); });
  req.on('end', () => {
    let veri;
    try { veri = JSON.parse(govde); } catch { return json(res, 400, { hata: 'Geçersiz veri' }); }
    if (!veri || typeof veri !== 'object') return json(res, 400, { hata: 'Geçersiz veri' });
    if (veri.site) return json(res, 200, { ok: true }); // bot tuzağı doluysa sessizce yoksay
    const temiz = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    const ad = temiz(veri.ad, 60), soyad = temiz(veri.soyad, 60);
    const rakam = String(veri.telefon || '').replace(/\D/g, '');
    const sermaye = Object.prototype.hasOwnProperty.call(SERMAYELER, String(veri.sermaye)) ? SERMAYELER[String(veri.sermaye)] : '';
    if (ad.length < 2 || soyad.length < 2) return json(res, 400, { hata: 'Lütfen adınızı ve soyadınızı yazın.' });
    if (rakam.length < 10 || rakam.length > 15) return json(res, 400, { hata: 'Lütfen telefon numaranızı alan koduyla birlikte yazın.' });
    if (!sermaye) return json(res, 400, { hata: 'Lütfen yaklaşık sermaye aralığını seçin.' });
    if (veri.riza !== true) return json(res, 400, { hata: 'Başvuru için onay kutusunu işaretlemeniz gerekir.' });
    liste.push(simdi); basvuruIstekler.set(ip, liste);
    if (basvuruIstekler.size > 5000) basvuruIstekler.clear();
    const kaynak = KAYNAKLAR.has(veri.kaynak) ? veri.kaynak : 'ana';
    const zaman = new Date(simdi + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const telefon = temiz(veri.telefon, 24);
    const metin = '🤖 Yeni robot başvurusu\n\nAd soyad: ' + ad + ' ' + soyad + '\nTelefon: ' + telefon +
      '\nYaklaşık sermaye: ' + sermaye + '\nGeldiği yer: ' + kaynak + '\nZaman: ' + zaman + ' (Türkiye)';
    // Yedek: Telegram o an ulaşmazsa başvuru kaybolmasın diye dosyaya da yazılır.
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.appendFile(BASVURU_FILE, JSON.stringify({ zaman, ad, soyad, telefon, sermaye, kaynak }) + '\n', () => {});
    });
    telegramGonder(metin).then(() => json(res, 200, { ok: true })).catch(err => {
      console.error('BASVURU Telegram hatası:', err.message);
      json(res, 502, { hata: 'Başvurunuz şu an iletilemedi. Lütfen birkaç dakika sonra yeniden deneyin.' });
    });
  });
}

// Geriye dönük test panelinin son günleri. Veri müşteri panelinden yalnız okunur ve beş dakika bellekte tutulur;
// ziyaretçinin tarayıcısı müşteri panelinin adresini hiç görmez.
const SERI_KAYNAK = process.env.ROBOT_SERI_KAYNAK || 'https://authentic-passion-production-d90e.up.railway.app/api/yedili-gunluk?son=90';
let seriBellek = { zaman: 0, govde: '[]' }, seriBekleyen = null;
function seriCek() {
  if (seriBekleyen) return seriBekleyen;
  seriBekleyen = new Promise(coz => {
    const u = new URL(SERI_KAYNAK);
    const istek = (u.protocol === 'http:' ? http : https).get(u, { timeout: 8000 }, r => {
      let c = ''; r.on('data', d => { c += d; if (c.length > 500000) istek.destroy(); });
      r.on('end', () => {
        try {
          const satirlar = JSON.parse(c);
          if (r.statusCode === 200 && Array.isArray(satirlar)) {
            // Yalnız panelin kullandığı iki alan dışarı verilir.
            seriBellek = { zaman: Date.now(), govde: JSON.stringify(satirlar.map(q => ({ tarih: q.tarih, pct: q.pct }))) };
          }
        } catch {}
        coz();
      });
    });
    istek.on('timeout', () => istek.destroy());
    istek.on('error', () => coz());
  }).then(() => { seriBekleyen = null; });
  return seriBekleyen;
}
function seriVer(req, res) {
  const gonder = () => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
    res.end(seriBellek.govde);
  };
  if (Date.now() - seriBellek.zaman < 5 * 60 * 1000) return gonder();
  seriCek().then(gonder);
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
  if (req.method === 'POST' && p === '/api/robot-basvuru') return basvuruAl(req, res);
  if (req.method === 'GET' && p === '/api/robot-seri') return seriVer(req, res);
  if (req.method === 'GET' && p === '/api/sayac') return sayacOku(req, res);
  if (req.method === 'GET' && p === '/yonetim') return yonetim(req, res);
  if (req.method === 'GET' && p === '/yonetim.csv') return yonetimCsv(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  html(res, 405, 'Yöntem desteklenmiyor');
}).listen(PORT, () => console.log('gurbuzguler.com sunucusu ' + PORT + ' portunda'));
