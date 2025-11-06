import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const API = {
  SPOT: "https://api3.binance.com",
  FUTURES: "https://fapi3.binance.com",
};

const PCT_1S = parseFloat(process.env.PCT_1S || 0.05);
const PCT_5S = parseFloat(process.env.PCT_5S || 0.15);
const VOL_MULT_15S = parseFloat(process.env.VOL_MULT_15S || 1.2);
const RSI_UP = parseFloat(process.env.RSI_UP || 52);
const RSI_DOWN = parseFloat(process.env.RSI_DOWN || 48);
const SYMBOL_CAP = parseInt(process.env.SYMBOL_CAP || 300);
const DEDUP_SEC = parseInt(process.env.DEDUP_SEC || 180);
const HEARTBEAT_N = parseInt(process.env.HEARTBEAT_N || 10);
const NO_HIT_SUMMARY = parseInt(process.env.NO_HIT_SUMMARY || 1);
const THROTTLE_NOHIT_SEC = parseInt(process.env.THROTTLE_NOHIT_SEC || 60);

// === DEBUG HANDLERS ===
process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));
console.log("=== SIGNAL BOT DEBUG MODE STARTED ===");

async function fetchJSON(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SignalBot/1.0 Chrome/120.0",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return await r.json();
  } catch (e) {
    console.error("[fetchJSON]", e);
    return null;
  }
}

async function getSymbols() {
  const data = await fetchJSON(`${API.SPOT}/api/v3/exchangeInfo`);
  if (!data || !data.symbols) return [];
  return data.symbols
    .filter((s) => s.symbol.endsWith("USDT"))
    .slice(0, SYMBOL_CAP)
    .map((s) => s.symbol);
}

function formatSignal(type, symbol, price, d1, d5, vol, rsi) {
  const emoji = type === "up" ? "📈" : "📉";
  const title = type === "up" ? "YÜKSELİŞ" : "DÜŞÜŞ";
  return `**${emoji} ${title}**\n• **${symbol}** ₮${price}\n1m:${d1.toFixed(
    2
  )}%  5m:${d5.toFixed(2)}%  Vol:${vol.toFixed(2)}×  RSI:${rsi.toFixed(1)}`;
}

async function sendTelegram(msg) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: msg,
          parse_mode: "Markdown",
        }),
      }
    );
    if (!r.ok) console.error("Telegram send error:", r.status);
  } catch (e) {
    console.error("[Telegram]", e);
  }
}

async function analyzeAndSend() {
  console.log("🔍 Tarama başladı...");
  const symbols = await getSymbols();
  console.log("🔢 Toplam sembol:", symbols.length);

  const hits = [];

  for (const s of symbols) {
    const data = await fetchJSON(`${API.SPOT}/api/v3/ticker/24hr?symbol=${s}`);
    if (!data) continue;

    const price = parseFloat(data.lastPrice);
    const d1 = parseFloat(data.priceChangePercent);
    const vol = parseFloat(data.quoteVolume);

    if (d1 > PCT_1S && vol > VOL_MULT_15S) {
      hits.push(formatSignal("up", s, price, d1, 0, vol, 60));
    } else if (d1 < -PCT_1S && vol > VOL_MULT_15S) {
      hits.push(formatSignal("down", s, price, d1, 0, vol, 40));
    }
  }

  if (hits.length > 0) {
    const msg = hits.join("\n\n");
    await sendTelegram(`> **Signal Tracker:**\n${msg}`);
  } else if (NO_HIT_SUMMARY) {
    await sendTelegram("ℹ️ Şu an sinyal yok (0 hit).");
  }

  console.log("✅ Tarama tamamlandı.");
}

(async () => {
  try {
    await analyzeAndSend();
  } catch (e) {
    console.error("MAIN ERROR:", e);
  }
})();
