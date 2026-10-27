// Parada Pusula Yapay Zekâ Radarı sunucusu
// Bağımlılık yok. Haftalık şifre kapısı + 15 dakikada bir yenilenen fiyatlar.
// Ortam değişkenleri: PORT, GIZLI_ANAHTAR (çerez imzası), ADMIN_ANAHTAR (/yonetim sayfası), SIFRE (listeyi ezen geçici şifre)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8798;
const GIZLI = process.env.GIZLI_ANAHTAR || crypto.randomBytes(32).toString("hex");
if (!process.env.GIZLI_ANAHTAR) console.warn("UYARI: GIZLI_ANAHTAR tanımlı değil, sunucu her yeniden başladığında abonelerin girişi düşer.");
const ADMIN = process.env.ADMIN_ANAHTAR || "";
const KOK = __dirname;
const YENILEME_DK = 15;

const oku = (p) => JSON.parse(fs.readFileSync(path.join(KOK, p), "utf8"));
const SIFRELER = oku("sifreler.json");
const HISSELER = oku("veri/hisseler.json");
const KATEGORILER = oku("veri/kategoriler.json");
// Borsa İstanbul kadrosu: ikinci top simgesiyle açılan saha için Türk hisseleri (Yahoo'da KOD.IS)
const BIST_HISSELER = oku("veri/bist_hisseler.json");
const BIST_KATEGORILER = oku("veri/bist_kategoriler.json");
// Patronun ilk 11'i (iki pazar): ana sayfada gömülü saha. "ozel" girdiler listede olmayan fonlar; yahoo kodu olanların fiyatı çekilir.
const ILK11 = oku("veri/ilk11.json");
const OZEL = [].concat.apply([], Object.keys(ILK11).map((k) => (ILK11[k].ozel || []).filter((o) => o.yahoo)));
const TUM_HISSELER = HISSELER.concat(BIST_HISSELER, OZEL);
const SAYFA = { radar: fs.readFileSync(path.join(KOK, "public", "radar.html"), "utf8"), giris: fs.readFileSync(path.join(KOK, "public", "giris.html"), "utf8") };

// ---- Hafta ve şifre ----
function istanbulSimdi() { return new Date(Date.now() + 3 * 3600 * 1000); }
function haftaBasi(d) {
  d = d || istanbulSimdi();
  const gun = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - gun)).toISOString().slice(0, 10);
}
function haftaSifresi(hb) {
  if (process.env.SIFRE) return process.env.SIFRE;
  const e = SIFRELER.filter((s) => s.hafta <= hb).sort((a, b) => (a.hafta < b.hafta ? 1 : -1))[0];
  return e ? e.sifre : null;
}
const TR = { "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c" };
function normalize(s) { return String(s || "").replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR[c]).trim().toLowerCase().replace(/[\s\-_.]+/g, ""); }
function imza(hb) { return crypto.createHmac("sha256", GIZLI).update(hb).digest("hex").slice(0, 32); }
function cerezOku(req) { const m = (req.headers.cookie || "").match(/(?:^|;\s*)radar_giris=([^;]+)/); return m ? decodeURIComponent(m[1]) : null; }
function girisliMi(req) {
  const t = cerezOku(req); if (!t) return false;
  const [hb, sig] = t.split("."); if (!hb || !sig) return false;
  if (hb !== haftaBasi()) return false;
  const b = imza(hb);
  return sig.length === b.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(b));
}
function guvenliMi(req) { return (req.headers["x-forwarded-proto"] || "").includes("https"); }
function cerezYaz(req, hb) {
  const parca = ["radar_giris=" + encodeURIComponent(hb + "." + imza(hb)), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + 8 * 24 * 3600];
  if (guvenliMi(req)) parca.push("Secure");
  return parca.join("; ");
}
function cerezSil() { return "radar_giris=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"; }

// ---- Deneme sınırı (IP başına 10 dakikada 12 deneme) ----
const deneme = new Map();
function denemeAsildi(ip) {
  const simdi = Date.now();
  const k = deneme.get(ip) || { n: 0, t: simdi };
  if (simdi - k.t > 10 * 60 * 1000) { k.n = 0; k.t = simdi; }
  k.n++; deneme.set(ip, k);
  return k.n > 12;
}

// ---- Fiyatlar ----
const fiyat = { veri: {}, zaman: 0, hata: null, surum: 0 };
async function tekFiyat(kod, yahoo) {
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(yahoo || kod) + "?range=1y&interval=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const s = j.chart && j.chart.result && j.chart.result[0];
  if (!s) throw new Error("boş sonuç");
  // TradingView ile aynı yöntem: dönem getirisi, dönemin ilk işlem gününün AÇILIŞ fiyatından ölçülür.
  // "1 ay" = son barın tarihinden bir takvim ayı geriye gidilen ilk işlem gününün açılışı; "yılbaşından" = yılın ilk işlem gününün açılışı.
  const ts = s.timestamp || [];
  const q = s.indicators.quote[0];
  const kapanis = q.close || [], acilis = q.open || [];
  const seri = [];
  for (let i = 0; i < kapanis.length; i++) if (kapanis[i] != null) seri.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: kapanis[i], o: acilis[i] != null ? acilis[i] : kapanis[i] });
  if (seri.length < 2) {
    // Geçmişi olmayan yeni fon/hisse (Yahoo tek bar döner): yalnız fiyat ve günlük değişim, ay/yılbaşı boş kalır
    const sonF = s.meta.regularMarketPrice, oncF = s.meta.chartPreviousClose || s.meta.previousClose;
    const gunF = oncF ? (sonF / oncF - 1) * 100 : s.meta.regularMarketChangePercent;
    if (sonF && typeof gunF === "number") return { fiyat: +sonF.toFixed(2), gun: +gunF.toFixed(2) };
    throw new Error("yetersiz veri");
  }
  const sonBar = seri[seri.length - 1];
  const son = s.meta.regularMarketPrice || sonBar.c;
  const onceki = seri[seri.length - 2].c;
  const sonTarih = new Date(sonBar.d + "T00:00:00Z");
  const hedef = new Date(Date.UTC(sonTarih.getUTCFullYear(), sonTarih.getUTCMonth() - 1, sonTarih.getUTCDate())).toISOString().slice(0, 10);
  const ayBar = seri.find((x) => x.d >= hedef) || seri[0];
  const yilBar = seri.find((x) => x.d.slice(0, 4) === sonBar.d.slice(0, 4)) || seri[0];
  return { fiyat: +son.toFixed(2), gun: +((son / onceki - 1) * 100).toFixed(2), ay: +((son / ayBar.o - 1) * 100).toFixed(1), ytd: +((son / yilBar.o - 1) * 100).toFixed(1) };
}
async function fiyatCek() {
  const sonuc = await Promise.allSettled(TUM_HISSELER.map((h) => tekFiyat(h.kod, h.yahoo)));
  const hatalar = [];
  sonuc.forEach((s, i) => {
    const kod = TUM_HISSELER[i].kod;
    if (s.status === "fulfilled") fiyat.veri[kod] = s.value; else hatalar.push(kod + ": " + s.reason.message);
  });
  fiyat.zaman = Date.now(); fiyat.hata = hatalar.length ? hatalar.join(" | ") : null; fiyat.surum++;
  console.log(new Date().toISOString(), "fiyatlar yenilendi", Object.keys(fiyat.veri).length + "/" + TUM_HISSELER.length, fiyat.hata || "");
}
fiyatCek().catch((e) => console.error("fiyat hatası", e.message));
setInterval(() => fiyatCek().catch((e) => console.error("fiyat hatası", e.message)), YENILEME_DK * 60 * 1000);

// ---- Yardımcılar ----
function gonder(res, kod, tip, govde, ek) {
  const b = { "Content-Type": tip, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
  Object.assign(b, ek || {});
  res.writeHead(kod, b); res.end(govde);
}
function govdeOku(req) {
  return new Promise((coz) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 4096) req.destroy(); });
    req.on("end", () => {
      const tip = req.headers["content-type"] || "";
      try { if (tip.includes("json")) return coz(JSON.parse(d || "{}")); } catch (e) { return coz({}); }
      coz(Object.fromEntries(new URLSearchParams(d)));
    });
  });
}
function ipAl(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?"; }
function kacir(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---- İstatistik (bellekte; sunucu yeniden başlayınca sıfırlanır, saat başı özet günlüğe yazılır) ----
const istat = { baslangic: Date.now(), gunler: {} };
function bugunKey() { return istanbulSimdi().toISOString().slice(0, 10); }
function gunKaydi() {
  const k = bugunKey();
  if (!istat.gunler[k]) istat.gunler[k] = { girisOk: 0, girisHata: 0, goruntuleme: 0, tekil: new Set() };
  const anahtarlar = Object.keys(istat.gunler).sort();
  while (anahtarlar.length > 45) delete istat.gunler[anahtarlar.shift()];
  return istat.gunler[k];
}
function ziyaretciKimlik(req) { return crypto.createHmac("sha256", GIZLI).update(ipAl(req) + "|" + (req.headers["user-agent"] || "")).digest("hex").slice(0, 16); }
function sayGiris(req, ok) { const g = gunKaydi(); if (ok) g.girisOk++; else g.girisHata++; console.log(new Date().toISOString(), ok ? "GIRIS ok" : "GIRIS hatali", "z=" + ziyaretciKimlik(req)); }
function sayGoruntuleme(req) { const g = gunKaydi(); g.goruntuleme++; g.tekil.add(ziyaretciKimlik(req)); }
setInterval(() => { const g = gunKaydi(); console.log(new Date().toISOString(), "OZET", bugunKey(), "tekil=" + g.tekil.size, "goruntuleme=" + g.goruntuleme, "girisOk=" + g.girisOk, "girisHata=" + g.girisHata); }, 60 * 60 * 1000);

// ---- Sunucu ----
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const yol = url.pathname;

  if (yol === "/saglik") return gonder(res, 200, "text/plain", "ok");

  if (yol === "/" || yol === "/index.html") {
    if (girisliMi(req)) { sayGoruntuleme(req); return gonder(res, 200, "text/html; charset=utf-8", SAYFA.radar); }
    return gonder(res, 200, "text/html; charset=utf-8", SAYFA.giris);
  }

  if (yol === "/giris" && req.method === "POST") {
    const ip = ipAl(req);
    if (denemeAsildi(ip)) return gonder(res, 429, "application/json", JSON.stringify({ hata: "Çok fazla deneme yaptınız. On dakika sonra tekrar deneyin." }));
    const govde = await govdeOku(req);
    const hb = haftaBasi();
    const dogru = haftaSifresi(hb);
    const ok = dogru && normalize(govde.sifre) === normalize(dogru);
    sayGiris(req, !!ok);
    if (!ok) return gonder(res, 401, "application/json", JSON.stringify({ hata: "Şifre yanlış. Bu haftanın şifresini abone hikâyesinden kontrol edin." }));
    deneme.delete(ip);
    return gonder(res, 200, "application/json", JSON.stringify({ ok: true }), { "Set-Cookie": cerezYaz(req, hb) });
  }

  if (yol === "/cikis") return gonder(res, 302, "text/plain", "", { "Set-Cookie": cerezSil(), Location: "/" });

  if (yol === "/api/veri") {
    if (!girisliMi(req)) return gonder(res, 401, "application/json", JSON.stringify({ hata: "giriş gerekli" }));
    const hisseler = HISSELER.map((h) => Object.assign({}, h, fiyat.veri[h.kod] || {}));
    const bist = { kategoriler: BIST_KATEGORILER, hisseler: BIST_HISSELER.map((h) => Object.assign({}, h, fiyat.veri[h.kod] || {})) };
    const ilk11 = {};
    Object.keys(ILK11).forEach((k) => { ilk11[k] = Object.assign({}, ILK11[k], { ozel: (ILK11[k].ozel || []).map((o) => Object.assign({}, o, fiyat.veri[o.kod] || {})) }); });
    return gonder(res, 200, "application/json; charset=utf-8", JSON.stringify({ guncelleme: fiyat.zaman, gecikmeDk: 15, yenilemeDk: YENILEME_DK, hafta: haftaBasi(), kategoriler: KATEGORILER, hisseler, bist, ilk11 }));
  }

  if (yol === "/yonetim") {
    if (!ADMIN || url.searchParams.get("anahtar") !== ADMIN) return gonder(res, 404, "text/plain", "yok");
    const hb = haftaBasi();
    const gelecek = SIFRELER.filter((s) => s.hafta >= hb).sort((a, b) => (a.hafta > b.hafta ? 1 : -1)).slice(0, 6);
    const satir = gelecek.map((s) => "<tr><td>" + s.hafta + (s.hafta === hb ? " (bu hafta)" : "") + "</td><td><b>" + kacir(s.sifre) + "</b></td></tr>").join("");
    const html = "<!doctype html><meta charset=utf-8><title>Radar yönetim</title><style>body{font:16px system-ui;padding:24px;max-width:640px}td{padding:6px 12px;border-bottom:1px solid #ddd}</style>" +
      "<h2>Radar yönetim</h2><p>Bu hafta: <b>" + hb + "</b>" + (process.env.SIFRE ? " (SIFRE ortam değişkeni listeyi eziyor)" : "") + "</p>" +
      "<table>" + satir + "</table>" +
      "<p>Fiyat yenileme: " + (fiyat.zaman ? new Date(fiyat.zaman + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + " (İstanbul)" : "henüz yok") + " · " + Object.keys(fiyat.veri).length + "/" + TUM_HISSELER.length + " hisse (" + HISSELER.length + " ABD + " + BIST_HISSELER.length + " BIST" + (OZEL.length ? " + " + OZEL.length + " fon" : "") + ")</p>" +
      (fiyat.hata ? "<p style='color:#b00'>Hatalar: " + kacir(fiyat.hata) + "</p>" : "") +
      "<h3>Ziyaret</h3><p style='color:#666;font-size:14px'>Tekil ziyaretçi = aynı gün içinde radarı açan farklı cihaz sayısı. Sayaç " + new Date(istat.baslangic + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + " (İstanbul) itibarıyla tutuluyor; sunucu yeniden başlarsa sıfırlanır, saat başı özet Railway günlüğüne yazılır.</p>" +
      "<table><tr><th>Gün</th><th>Tekil ziyaretçi</th><th>Sayfa açılışı</th><th>Başarılı giriş</th><th>Yanlış şifre</th></tr>" +
      Object.keys(istat.gunler).sort().reverse().map((k) => { const g = istat.gunler[k]; return "<tr><td>" + k + "</td><td><b>" + g.tekil.size + "</b></td><td>" + g.goruntuleme + "</td><td>" + g.girisOk + "</td><td>" + g.girisHata + "</td></tr>"; }).join("") +
      "</table>";
    return gonder(res, 200, "text/html; charset=utf-8", html);
  }

  gonder(res, 404, "text/plain; charset=utf-8", "Sayfa yok");
}).listen(PORT, () => console.log("Radar sunucusu http://localhost:" + PORT + "  bu hafta:", haftaBasi()));
