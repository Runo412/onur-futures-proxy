// signal.js — GitHub Actions ile 2/5 dk'da bir tarar, sinyalleri TELEGRAM'a yollar.
// Ortam değişkenleri (Secrets): TELEGRAM_TOKEN, CHAT_ID
// Opsiyonel Variables: SYMBOL_CAP, PCT_1M, PCT_5M, VOL_MULT_15, RSI_UP, RSI_DOWN, RSI_OB, RSI_OS

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_TOKEN ve/veya CHAT_ID eksik!");
  process.exit(1);
}

// ---- Parametreler (repo Settings → Actions → Variables ile override edebilirsin) ----
const SYMBOL_CAP   = +(process.env.SYMBOL_CAP   || 150);   // max taranacak USDT çifti
const PCT_1M       = +(process.env.PCT_1M       || 0.10);  // 1 dak % eşiği (örn 0.10 = %0.10)
const PCT_5M       = +(process.env.PCT_5M       || 0.30);  // 5 dak % eşiği
const VOL_MULT_15  = +(process.env.VOL_MULT_15  || 1.2);   // son 1dk hacim > SMA15 * çarpan
const RSI_UP       = +(process.env.RSI_UP       || 55);    // yükseliş sinyali için RSI alt eşiği
const RSI_DOWN     = +(process.env.RSI_DOWN     || 45);    // düşüş sinyali için RSI üst eşiği
const RSI_OB       = +(process.env.RSI_OB       || 70);    // aşırı alım eşiği
const RSI_OS       = +(process.env.RSI_OS       || 30);    // aşırı satış eşiği
const TOP_N        = SYMBOL_CAP;

const HOSTS = [
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://data-api.binance.vision"
];

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36";

async function getJsonAny(path, params = "") {
  let lastErr;
  for (const h of HOSTS) {
    const url = h + path + params;
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept": "application/json" } });
      if (!r.ok) { lastErr = `${r.status} @ ${url}`; continue; }
      return await r.json();
    } catch (e) { lastErr = e.message; }
  }
  throw new Error("All hosts failed: " + lastErr);
}

function rsi14(closes) {
  if (closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  gains /= 14; losses /= 14;
  let rs = losses === 0 ? 100 : gains / losses;
  let rsi = 100 - (100 / (1 + rs));
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gains = (gains * 13 + g) / 14;
    losses = (losses * 13 + l) / 14;
    rs = losses === 0 ? 100 : gains / losses;
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}

function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("Telegram send failed:", r.status, t);
  }
}

function fmt(n, d=4) {
  const f = Number(n);
  return Number.isFinite(f) ? f.toFixed(d) : String(n);
}

// Ek etiketler (aşırı alım/satış)
function rsiBadge(rsi) {
  if (rsi == null) return "";
  if (rsi >= RSI_OB) return " ⚠️<b>Aşırı Alım</b>";
  if (rsi <= RSI_OS) return " 💫<b>Aşırı Satış</b>";
  return "";
}

(async () => {
  const ex = await getJsonAny("/api/v3/exchangeInfo", "?permissions=SPOT");
  const usdt = ex.symbols
    .filter(s => s.status === "TRADING" && s.symbol.endsWith("USDT"))
    .slice(0, TOP_N)
    .map(s => s.symbol);

  const hits = [];

  for (const sym of usdt) {
    // 1m klines (30 adet): [openTime, open, high, low, close, volume, ...]
    const kl = await getJsonAny("/api/v3/klines", `?symbol=${sym}&interval=1m&limit=30`);
    if (!Array.isArray(kl) || kl.length < 16) continue;

    const closes = kl.map(k => +k[4]);
    const vols   = kl.map(k => +k[5]);

    const lastClose   = closes[closes.length - 1];
    const prevClose   = closes[closes.length - 2];
    const close_5mins = closes[closes.length - 6];

    const pct1 = ((lastClose - prevClose) / prevClose) * 100;
    const pct5 = ((lastClose - close_5mins) / close_5mins) * 100;

    const vLast = vols[vols.length - 1];
    const vSma15 = sma(vols, 15);
    const vMult = vSma15 ? (vLast / vSma15) : 0;

    const rsi = rsi14(closes);

    // Temel filtreler
    const up   = (pct1 >= PCT_1M || pct5 >= PCT_5M) && vMult >= VOL_MULT_15 && rsi !== null && rsi >= RSI_UP;
    const down = (pct1 <= -PCT_1M || pct5 <= -PCT_5M) && vMult >= VOL_MULT_15 && rsi !== null && rsi <= RSI_DOWN;

    // İyileştirme: aşırı alım/satış etiketi
    const badge = rsiBadge(rsi);

    if (up || down || badge) {
      hits.push({
        sym,
        price: lastClose,
        pct1, pct5,
        vMult,
        rsi,
        dir: up ? "UP" : (down ? "DOWN" : "NEUTRAL"),
        badge
      });
    }
  }

  // Ayrıştır
  const upList     = hits.filter(h => h.dir === "UP");
  const downList   = hits.filter(h => h.dir === "DOWN");
  const neutralOB  = hits.filter(h => h.dir === "NEUTRAL" && h.rsi >= RSI_OB); // RSI yüksek ama up koşulu yok
  const neutralOS  = hits.filter(h => h.dir === "NEUTRAL" && h.rsi <= RSI_OS); // RSI düşük ama down koşulu yok

  // Mesajlar
  if (upList.length) {
    const lines = upList
      .sort((a,b)=>b.pct1 - a.pct1)
      .slice(0, 20)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  RSI:${fmt(h.rsi,1)}${h.badge}`);
    await sendTelegram(`📈 <b>YÜKSELİŞ</b>\n${lines.join("\n")}`);
  }

  if (downList.length) {
    const lines = downList
      .sort((a,b)=>a.pct1 - b.pct1)
      .slice(0, 20)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  RSI:${fmt(h.rsi,1)}${h.badge}`);
    await sendTelegram(`📉 <b>DÜŞÜŞ</b>\n${lines.join("\n")}`);
  }

  // Yalnızca aşırı alım/satış (yön koşulları sağlanmadı ama RSI uçta)
  if (neutralOB.length) {
    const lines = neutralOB
      .sort((a,b)=>b.rsi - a.rsi)
      .slice(0, 15)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  RSI:${fmt(h.rsi,1)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  ⚠️ Olası kar realizasyonu`);
    await sendTelegram(`🟧 <b>RSI AŞIRI ALIM (>${RSI_OB})</b>\n${lines.join("\n")}`);
  }

  if (neutralOS.length) {
    const lines = neutralOS
      .sort((a,b)=>a.rsi - b.rsi)
      .slice(0, 15)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  RSI:${fmt(h.rsi,1)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  💫 Olası tepki yükselişi`);
    await sendTelegram(`🟦 <b>RSI AŞIRI SATIŞ (<${RSI_OS})</b>\n${lines.join("\n")}`);
  }

  // Özet
  const totalHits = upList.length + downList.length + neutralOB.length + neutralOS.length;
  if (totalHits === 0) {
    await sendTelegram(`🫥 <b>0 hit</b> • Tarandı: ${usdt.length} • Eşikler: 1m≥${PCT_1M}%  5m≥${PCT_5M}%  Vol≥${VOL_MULT_15}×  RSI↑≥${RSI_UP}/RSI↓≤${RSI_DOWN}  OB>${RSI_OB}/OS<${RSI_OS}`);
  } else {
    await sendTelegram(`✅ Özet • Tarandı: ${usdt.length} • Hit: ${totalHits} • (↑:${upList.length} ↓:${downList.length} OB:${neutralOB.length} OS:${neutralOS.length}) • Eşikler: 1m≥${PCT_1M}%  5m≥${PCT_5M}%  Vol≥${VOL_MULT_15}×  RSI↑≥${RSI_UP}/RSI↓≤${RSI_DOWN}  OB>${RSI_OB}/OS<${RSI_OS}`);
  }
})().catch(async (e) => {
  console.error(e);
  await sendTelegram(`⚠️ Hata: <code>${(e && e.message) || e}</code>`);
  process.exit(1);
});
