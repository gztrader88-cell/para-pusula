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
  const ts = s.timestamp || [];
  const ham = (s.indicators.quote[0].close || []);
  const seri = []; for (let i = 0; i < ham.length; i++) if (ham[i] != null) seri.push({ t: ts[i], c: ham[i] });
  if (seri.length < 2) throw new Error("yetersiz veri");
  const son = s.meta.regularMarketPrice || seri[seri.length - 1].c;
  const onceki = seri[seri.length - 2].c;
  const ayOnce = seri[Math.max(0, seri.length - 22)].c;
  const yil = istanbulSimdi().getUTCFullYear();
  const yilIlk = seri.find((x) => new Date(x.t * 1000).getUTCFullYear() === yil);
  const ytdTaban = yilIlk ? (seri[Math.max(0, seri.indexOf(yilIlk) - 1)].c) : seri[0].c;
  return { fiyat: +son.toFixed(2), gun: +((son / onceki - 1) * 100).toFixed(2), ay: +((son / ayOnce - 1) * 100).toFixed(1), ytd: +((son / ytdTaban - 1) * 100).toFixed(1) };
}
async function fiyatCek() {
  const sonuc = await Promise.allSettled(HISSELER.map((h) => tekFiyat(h.kod, h.yahoo)));
  const hatalar = [];
  sonuc.forEach((s, i) => {
    const kod = HISSELER[i].kod;
    if (s.status === "fulfilled") fiyat.veri[kod] = s.value; else hatalar.push(kod + ": " + s.reason.message);
  });
  fiyat.zaman = Date.now(); fiyat.hata = hatalar.length ? hatalar.join(" | ") : null; fiyat.surum++;
  console.log(new Date().toISOString(), "fiyatlar yenilendi", Object.keys(fiyat.veri).length + "/" + HISSELER.length, fiyat.hata || "");
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

// ---- Sunucu ----
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const yol = url.pathname;

  if (yol === "/saglik") return gonder(res, 200, "text/plain", "ok");

  if (yol === "/" || yol === "/index.html") {
    if (girisliMi(req)) return gonder(res, 200, "text/html; charset=utf-8", SAYFA.radar);
    return gonder(res, 200, "text/html; charset=utf-8", SAYFA.giris);
  }

  if (yol === "/giris" && req.method === "POST") {
    const ip = ipAl(req);
    if (denemeAsildi(ip)) return gonder(res, 429, "application/json", JSON.stringify({ hata: "Çok fazla deneme yaptınız. On dakika sonra tekrar deneyin." }));
    const govde = await govdeOku(req);
    const hb = haftaBasi();
    const dogru = haftaSifresi(hb);
    const ok = dogru && normalize(govde.sifre) === normalize(dogru);
    if (!ok) return gonder(res, 401, "application/json", JSON.stringify({ hata: "Şifre yanlış. Bu haftanın şifresini abone hikâyesinden kontrol edin." }));
    deneme.delete(ip);
    return gonder(res, 200, "application/json", JSON.stringify({ ok: true }), { "Set-Cookie": cerezYaz(req, hb) });
  }

  if (yol === "/cikis") return gonder(res, 302, "text/plain", "", { "Set-Cookie": cerezSil(), Location: "/" });

  if (yol === "/api/veri") {
    if (!girisliMi(req)) return gonder(res, 401, "application/json", JSON.stringify({ hata: "giriş gerekli" }));
    const hisseler = HISSELER.map((h) => Object.assign({}, h, fiyat.veri[h.kod] || {}));
    return gonder(res, 200, "application/json; charset=utf-8", JSON.stringify({ guncelleme: fiyat.zaman, gecikmeDk: 15, yenilemeDk: YENILEME_DK, hafta: haftaBasi(), kategoriler: KATEGORILER, hisseler }));
  }

  if (yol === "/yonetim") {
    if (!ADMIN || url.searchParams.get("anahtar") !== ADMIN) return gonder(res, 404, "text/plain", "yok");
    const hb = haftaBasi();
    const gelecek = SIFRELER.filter((s) => s.hafta >= hb).sort((a, b) => (a.hafta > b.hafta ? 1 : -1)).slice(0, 6);
    const satir = gelecek.map((s) => "<tr><td>" + s.hafta + (s.hafta === hb ? " (bu hafta)" : "") + "</td><td><b>" + kacir(s.sifre) + "</b></td></tr>").join("");
    const html = "<!doctype html><meta charset=utf-8><title>Radar yönetim</title><style>body{font:16px system-ui;padding:24px;max-width:640px}td{padding:6px 12px;border-bottom:1px solid #ddd}</style>" +
      "<h2>Radar yönetim</h2><p>Bu hafta: <b>" + hb + "</b>" + (process.env.SIFRE ? " (SIFRE ortam değişkeni listeyi eziyor)" : "") + "</p>" +
      "<table>" + satir + "</table>" +
      "<p>Fiyat yenileme: " + (fiyat.zaman ? new Date(fiyat.zaman + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + " (İstanbul)" : "henüz yok") + " · " + Object.keys(fiyat.veri).length + "/" + HISSELER.length + " hisse</p>" +
      (fiyat.hata ? "<p style='color:#b00'>Hatalar: " + kacir(fiyat.hata) + "</p>" : "");
    return gonder(res, 200, "text/html; charset=utf-8", html);
  }

  gonder(res, 404, "text/plain; charset=utf-8", "Sayfa yok");
}).listen(PORT, () => console.log("Radar sunucusu http://localhost:" + PORT + "  bu hafta:", haftaBasi()));
