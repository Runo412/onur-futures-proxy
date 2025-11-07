// === SIGNAL TRACKER (DEBUG EDITION) ===
// Ayrıntılı log ve eşik analizleri için
// Node 20+ ortamında çalışır

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SYMBOL_CAP = parseInt(process.env.SYMBOL_CAP || "300", 10);
const PCT_1M = parseFloat(process.env.PCT_1M || "0.08");
const PCT_5M = parseFloat(process.env.PCT_5M || "0.20");
const VOL_MULT_15 = parseFloat(process.env.VOL_MULT_15 || "1.2");
const RSI_UP = parseFloat(process.env.RSI_UP || "52");
const RSI_DOWN = parseFloat(process.env.RSI_DOWN || "48");
const NO_HIT_SUMMARY = parseInt(process.env.NO_HIT_SUMMARY || "1", 10);
const DEBUG_PING = parseInt(process.env.DEBUG_PING || "0", 10);

console.log("=== SIGNAL BOT (DEBUG MODE) ===", {
  cap: SYMBOL_CAP, PCT_1M, PCT_5M, VOL_MULT_15, RSI_UP, RSI_DOWN
});

process.on("unhandledRejection", e => console.error("[UNHANDLED]", e));
process.on("uncaughtException", e => console.error("[UNCAUGHT]", e));

const SPOT_BASES = [
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com",
  "https://api2.binance.com",
];

async function fetchJSON(bases, path, timeoutMs = 10000) {
  let lastErr;
  for (const base of bases) {
    const url = `${base}${path}`;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) {
        console.warn(`[fetchJSON] ${res.status} @ ${url}`);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        lastErr = new Error(`Bad JSON from ${url}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All hosts failed");
}

async function tg(text, parseMode = "Markdown") {
  if (!TELEGRAM_TOKEN || !CHAT_ID) return console.error("[Telegram] eksik bilgi!");
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: parseMode }),
    });
  } catch (e) {
    console.error("[Telegram]", e);
  }
}

async function getSpotSymbols() {
  const j = await fetchJSON(SPOT_BASES, "/api/v3/exchangeInfo?permissions=SPOT");
  return (j.symbols || [])
    .filter(s => s.status === "TRADING" && s.symbol.endsWith("USDT"))
    .map(s => s.symbol)
    .slice(0, SYMBOL_CAP);
}

async function getTicker(symbol) {
  return await fetchJSON(SPOT_BASES, `/api/v3/ticker/24hr?symbol=${symbol}`);
}

function fmtLine(type, s, price, d1, volx, rsi) {
  const emoji = type === "up" ? "📈" : "📉";
  const title = type === "up" ? "YÜKSELİŞ" : "DÜŞÜŞ";
  return `**${emoji} ${title}**\n• **${s}** ₮${price}  1m:${d1.toFixed(2)}%  Vol:${volx.toFixed(2)}×  RSI:${rsi.toFixed(1)}`;
}

async function scanOnce() {
  const syms = await getSpotSymbols();
  console.log("Toplam sembol:", syms.length);
  const hits = [];

  for (const s of syms) {
    let d;
    try {
      d = await getTicker(s);
    } catch {
      console.warn(`[SKIP] ${s} - fetch error`);
      continue;
    }

    const price = parseFloat(d.lastPrice || "0");
    const d1 = parseFloat(d.priceChangePercent || "0");
    const volx = Math.max(1, parseFloat(d.quoteVolume || "0") / Math.max(1, parseFloat(d.volume || "1")));
    const rsi = d1 > 0 ? 60 : 40;

    // Ayrıntılı log 👇
    console.log(`🧩 ${s} | Δ1m=${d1.toFixed(2)}% | Vol=${volx.toFixed(2)}× | RSI=${rsi}`);

    if (d1 >= PCT_1M && volx >= VOL_MULT_15 && rsi >= RSI_UP) {
      console.log(`✅ HIT UP: ${s}`);
      hits.push(fmtLine("up", s, price, d1, volx, rsi));
    } else if (d1 <= -PCT_1M && volx >= VOL_MULT_15 && rsi <= RSI_DOWN) {
      console.log(`⚠️ HIT DOWN: ${s}`);
      hits.push(fmtLine("down", s, price, d1, volx, rsi));
    } else {
      console.log(`❌ ${s} elendi.`);
    }
  }

  if (hits.length) {
    await tg(`> **Signal Tracker:**\n${hits.join("\n\n")}`);
  } else if (NO_HIT_SUMMARY) {
    await tg("ℹ️ Şu an sinyal yok (0 hit).");
  }
  console.log(`✅ Tarama tamamlandı. Toplam hit: ${hits.length}`);
}

(async () => {
  if (DEBUG_PING) await tg("🧪 Debug mod aktif. Ayrıntılı log başlatıldı.");
  await scanOnce();
})();
