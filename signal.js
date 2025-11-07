// === SIGNAL TRACKER — Spot + Futures (USDT-M) ===
// Node 20+ (global fetch). Telegram: TELEGRAM_TOKEN, CHAT_ID

// ---------- ENV / AYARLAR ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Spot eşikleri
const SYMBOL_CAP = parseInt(process.env.SYMBOL_CAP || "300", 10);
const PCT_1M = parseFloat(process.env.PCT_1M || "0.08");
const PCT_5M = parseFloat(process.env.PCT_5M || "0.20");   // şimdilik bilgilendirici
const VOL_MULT_15 = parseFloat(process.env.VOL_MULT_15 || "1.2");
const RSI_UP = parseFloat(process.env.RSI_UP || "52");
const RSI_DOWN = parseFloat(process.env.RSI_DOWN || "48");

// Futures aç/kapat
const ENABLE_FUTURES = parseInt(process.env.ENABLE_FUTURES || "1", 10);
const FUTURES_CAP = parseInt(process.env.FUTURES_CAP || "200", 10);
const FUTURES_CONTRACT = process.env.FUTURES_CONTRACT || "PERPETUAL"; // PERPETUAL / CURRENT_QUARTER vs.

// Bilgilendirme
const NO_HIT_SUMMARY = parseInt(process.env.NO_HIT_SUMMARY || "1", 10);
const DEBUG_PING = parseInt(process.env.DEBUG_PING || "0", 10);

// ---------- LOG / ERROR ----------
process.on("unhandledRejection", e => console.error("[UNHANDLED]", e?.stack || e));
process.on("uncaughtException", e => console.error("[UNCAUGHT]", e?.stack || e));

console.log("=== SIGNAL BOT START ===", {
  node: process.version,
  spotCap: SYMBOL_CAP, futCap: FUTURES_CAP, enableFutures: ENABLE_FUTURES,
  p1m: PCT_1M, p5m: PCT_5M, vol: VOL_MULT_15, up: RSI_UP, down: RSI_DOWN
});

// ---------- HOST ROTATION ----------
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SignalBot/1.0 Chrome/120 Safari/537.36";

// SPOT
const SPOT_BASES = [
  "https://data-api.binance.vision", // genelde 451/403 yemez
  "https://api-gcp.binance.com",
  "https://api2.binance.com",
];

// FUTURES (USDT-M). Not: bazı ortamlarda 403/451 gelebilir.
const FUT_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
];

async function fetchJSONFromBases(bases, path, timeoutMs = 12000) {
  let lastErr = null;
  for (const base of bases) {
    const url = `${base}${path}`;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { headers: { "user-agent": UA, "accept": "application/json,text/plain,*/*" }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status} @ ${url}`);
        continue;
      }
      const text = await r.text();
      try { return JSON.parse(text); }
      catch { lastErr = new Error(`Non-JSON @ ${url} : ${text.slice(0,120)}`); }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All hosts failed");
}

// ---------- SPOT HELPERS ----------
async function getSpotSymbols() {
  const data = await fetchJSONFromBases(SPOT_BASES, "/api/v3/exchangeInfo?permissions=SPOT");
  return (data?.symbols || [])
    .filter(s => s.status === "TRADING" && s.symbol.endsWith("USDT"))
    .map(s => s.symbol)
    .slice(0, SYMBOL_CAP);
}

async function getSpotTicker24h(symbol) {
  return await fetchJSONFromBases(SPOT_BASES, `/api/v3/ticker/24hr?symbol=${symbol}`);
}

// ---------- FUTURES HELPERS (USDT-M) ----------
async function getFuturesSymbols() {
  // exchangeInfo → USDT-quoted + contractType=PERPETUAL
  const data = await fetchJSONFromBases(FUT_BASES, "/fapi/v1/exchangeInfo");
  const list = (data?.symbols || [])
    .filter(s =>
      s.status === "TRADING" &&
      s.quoteAsset === "USDT" &&
      (FUTURES_CONTRACT ? s.contractType === FUTURES_CONTRACT : true)
    )
    .map(s => s.symbol);
  return list.slice(0, FUTURES_CAP);
}

async function getFuturesTicker24h(symbol) {
  return await fetchJSONFromBases(FUT_BASES, `/fapi/v1/ticker/24hr?symbol=${symbol}`);
}

// ---------- TELEGRAM ----------
async function tg(text, parseMode = "Markdown") {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("[Telegram] CHAT_ID/TELEGRAM_TOKEN eksik");
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: parseMode }),
    });
    if (!r.ok) console.error(`[Telegram] HTTP ${r.status}`);
  } catch (e) {
    console.error("[Telegram]", e?.message || e);
  }
}

function line(type, market, s, price, d1, volx, rsi) {
  const emoji = type === "up" ? "📈" : "📉";
  const title = type === "up" ? "YÜKSELİŞ" : "DÜŞÜŞ";
  const tag = market === "FUT" ? " (FUT)" : "";
  return `**${emoji} ${title}${tag}**\n• **${s}**  ₮${price}  1m:${d1.toFixed(2)}%  5m:${(0).toFixed(2)}%  Vol:${volx.toFixed(2)}×  RSI:${rsi.toFixed(1)}`;
}

// Basit “1m” kabaca 24h yüzdesinden; istersen kline ile gerçek 1m/5m’ye geçebiliriz.
function quickDerive(d24) {
  const price = parseFloat(d24.lastPrice || "0");
  const d1 = parseFloat(d24.priceChangePercent || "0");
  const volx = Math.max(1, parseFloat(d24.quoteVolume || "0") / Math.max(1, parseFloat(d24.volume || "1")));
  const rsi = d1 >= 0 ? 60 : 40;
  return { price, d1, volx, rsi };
}

function passUp(sig)  { return sig.d1 >= PCT_1M && sig.volx >= VOL_MULT_15 && sig.rsi >= RSI_UP; }
function passDown(sig){ return sig.d1 <= -PCT_1M && sig.volx >= VOL_MULT_15 && sig.rsi <= RSI_DOWN; }

// ---------- SCAN ----------
async function scanSpot() {
  let syms = [];
  try { syms = await getSpotSymbols(); } catch (e) {
    console.error("[Spot exchangeInfo]", e?.message || e);
    return [];
  }
  console.log("SPOT sembol:", syms.length);

  const hits = [];
  for (const s of syms) {
    try {
      const d = await getSpotTicker24h(s);
      const sig = quickDerive(d);
      if (!Number.isFinite(sig.price)) continue;
      if (passUp(sig))   hits.push(line("up", "SPOT", s, sig.price, sig.d1, sig.volx, sig.rsi));
      else if (passDown(sig)) hits.push(line("down","SPOT", s, sig.price, sig.d1, sig.volx, sig.rsi));
    } catch {}
  }
  return hits;
}

async function scanFutures() {
  if (!ENABLE_FUTURES) return { hits: [], ok: false, reason: "disabled" };
  let syms = [];
  try { syms = await getFuturesSymbols(); }
  catch (e) {
    console.error("[Futures exchangeInfo]", e?.message || e);
    return { hits: [], ok: false, reason: "blocked_or_error" };
  }
  console.log("FUTURES sembol:", syms.length);

  const hits = [];
  for (const s of syms) {
    try {
      const d = await getFuturesTicker24h(s);
      const sig = quickDerive(d);
      if (!Number.isFinite(sig.price)) continue;
      if (passUp(sig))   hits.push(line("up", "FUT", s, sig.price, sig.d1, sig.volx, sig.rsi));
      else if (passDown(sig)) hits.push(line("down","FUT", s, sig.price, sig.d1, sig.volx, sig.rsi));
    } catch {}
  }
  return { hits, ok: true };
}

// ---------- MAIN ----------
(async () => {
  try {
    if (DEBUG_PING) await tg("🧪 Ping: Signal bot çalıştı (spot+futures).");

    const spotHits = await scanSpot();
    const futRes = await scanFutures(); // {hits, ok, reason?}

    const all = [...spotHits, ...futRes.hits];

    if (all.length) {
      await tg(`> **Signal Tracker:**\n${all.join("\n\n")}`);
    } else if (NO_HIT_SUMMARY) {
      await tg(`ℹ️ Şu an sinyal yok (0 hit).`);
    }

    if (ENABLE_FUTURES && !futRes.ok && futRes.reason === "blocked_or_error") {
      // Bölge engeli vs. tek satır bilgi düş
      await tg("⚠️ Futures verisine erişilemedi (403/451/engelleme olabilir). Spot devam ediyor.");
    }

    console.log(`✅ Bitti. Hits: spot=${spotHits.length}, fut=${futRes.hits?.length || 0}`);
  } catch (e) {
    console.error("MAIN ERROR:", e?.stack || e);
    await tg(`⚠️ Hata: ${e?.message || e}`);
    process.exitCode = 1;
  }
})();
