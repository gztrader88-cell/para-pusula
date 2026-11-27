// Müşteri panelindeki Altılı Takip sayfasından sitenin robot panelini üretir.
// Kaynak dosya yalnız okunur. Çıktı public/robot-panel.html dosyasıdır ve /robot sayfasının içinde gösterilir.
// Kullanım: node robot-panel-kur.js [kaynak dosya yolu]
// Altılı Takip sayfası her yeniden üretildiğinde (haftalık mühür) bu betik de çalıştırılır.
'use strict';
const fs = require('fs');
const path = require('path');

const KAYNAK = process.argv[2] || 'C:/Users/User/Desktop/Tradingview/musteri-panel/yedili_takip.html';
const HEDEF = path.join(__dirname, 'public', 'robot-panel.html');

let s = fs.readFileSync(KAYNAK, 'utf8');
function degistir(desen, yeni, ad) {
  if (!desen.test(s)) throw new Error('Kaynakta beklenen bölüm bulunamadı: ' + ad);
  s = s.replace(desen, yeni);
}
// 1) Müşteri paneline dönen "Ana Sayfa" düğmesi kaldırılır.
degistir(/<a id="geriBtn"[^>]*>[^<]*<\/a>\s*/, '', 'Ana Sayfa düğmesi');
// 2) Son günler müşteri panelinden değil, sitenin kendi ucundan okunur.
degistir(/fetch\('https?:\/\/[^']*\/api\/yedili-gunluk[^']*'\)/, "fetch('/api/robot-seri')", 'canlı veri adresi');
// 3) Arama motorları bu iç sayfayı ayrı bir sayfa olarak listelemesin.
degistir(/<title>[^<]*<\/title>/, '<title>Geriye dönük test paneli</title>\n<meta name="robots" content="noindex">', 'başlık');

if (/authentic-passion|railway\.app/.test(s)) throw new Error('Çıktıda müşteri paneli adresi kaldı, dosya yazılmadı.');
fs.writeFileSync(HEDEF, s);
console.log('Yazıldı: ' + HEDEF + ' (' + Math.round(s.length / 1024) + ' KB)');
