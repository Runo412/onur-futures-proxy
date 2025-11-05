// signal.js — GitHub Actions ile 5 dakikada bir çalışır, sinyalleri TELEGRAM'a gönderir.
// Node 20+ gerekir (Actions'ta biz ayarlıyoruz).
// Ortam değişkenleri (Secrets): TELEGRAM_TOKEN, CHAT_ID
// Opsiyonel: SYMBOL_CAP, PCT_1M, PCT_5M, VOL_MULT_15, RSI_UP, RSI_DOWN

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_TOKEN ve/veya CHAT_ID eksik!");
  process.exit(1);
}

// ---- Parametreler (istersen repo Settings→Actions→Variables ile override et) ----
const SYMBOL_CAP   = +(process.env.SYMBOL_CAP   || 150);   // max kaç USDT çifti
const PCT_1M       = +(process.env.PCT_1M       || 0.10);  // 1 dak % eşik (örn 0.10 = %0.10)
const PCT_5M       = +(process.env.PCT_5M       || 0.30);  // 5 dak % eşik
const VOL_MULT_15  = +(process.env.VOL_MULT_15  || 1.2);   // son 1dk hacim > SMA15 * çarpan
const RSI_UP       = +(process.env.RSI_UP       || 55);    // yükseliş sinyali için RSI alt eşiği
const RSI_DOWN     = +(process.env.RSI_DOWN     || 45);    // düşüş sinyali için RSI üst eşiği
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
  // Wilder RSI(14)
  if (closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  gains /= 14; losses /= 14;
  let rs = losses === 0 ? 100 : gains / losses;
  let rsi = 100 - (100 / (1 + rs));
  // smooth
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    gains = (gains * 13 + gain) / 14;
    losses = (losses * 13 + loss) / 14;
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
  return isFinite(f) ? f.toFixed(d) : String(n);
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

    // filtre
    const up   = (pct1 >= PCT_1M || pct5 >= PCT_5M) && vMult >= VOL_MULT_15 && rsi !== null && rsi >= RSI_UP;
    const down = (pct1 <= -PCT_1M || pct5 <= -PCT_5M) && vMult >= VOL_MULT_15 && rsi !== null && rsi <= RSI_DOWN;

    if (up || down) {
      hits.push({
        sym,
        price: lastClose,
        pct1, pct5,
        vMult,
        rsi,
        dir: up ? "UP" : "DOWN"
      });
    }
  }

  if (hits.length === 0) {
    await sendTelegram(`🫥 <b>0 hit</b> • Tarandı: ${usdt.length} sembol • Eşikler: 1m≥${PCT_1M}%  5m≥${PCT_5M}%  Vol≥${VOL_MULT_15}×  RSI↑≥${RSI_UP}/RSI↓≤${RSI_DOWN}`);
    return;
  }

  // Gruplayıp gönder
  const upList   = hits.filter(h => h.dir === "UP");
  const downList = hits.filter(h => h.dir === "DOWN");

  if (upList.length) {
    const lines = upList
      .sort((a,b)=>b.pct1 - a.pct1)
      .slice(0, 20)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  RSI:${fmt(h.rsi,1)}`);
    await sendTelegram(`📈 <b>YÜKSELİŞ</b>\n${lines.join("\n")}`);
  }

  if (downList.length) {
    const lines = downList
      .sort((a,b)=>a.pct1 - b.pct1)
      .slice(0, 20)
      .map(h => `• <code>${h.sym}</code>  ₮${fmt(h.price, 6)}  1m:${fmt(h.pct1,2)}%  5m:${fmt(h.pct5,2)}%  Vol:${fmt(h.vMult,2)}×  RSI:${fmt(h.rsi,1)}`);
    await sendTelegram(`📉 <b>DÜŞÜŞ</b>\n${lines.join("\n")}`);
  }

  await sendTelegram(`✅ Özet • Tarandı: ${usdt.length} • Hit: ${hits.length} • Eşikler: 1m≥${PCT_1M}%  5m≥${PCT_5M}%  Vol≥${VOL_MULT_15}×  RSI↑≥${RSI_UP}/RSI↓≤${RSI_DOWN}`);
})().catch(async (e) => {
  console.error(e);
  await sendTelegram(`⚠️ Hata: <code>${(e && e.message) || e}</code>`);
  process.exit(1);
});
