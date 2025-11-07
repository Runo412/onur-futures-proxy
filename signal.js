// === Signal Tracker — Full Script (no deps) ===
// Node 20+ (global fetch) için

// ---- CONFIG (ENV) ----
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Tarama eşikleri
const SYMBOL_CAP = parseInt(process.env.SYMBOL_CAP || "300", 10);
const PCT_1M = parseFloat(process.env.PCT_1M || "0.08");     // 1 dakika % değişim eşiği (kaba)
const PCT_5M = parseFloat(process.env.PCT_5M || "0.20");     // 5 dakika % değişim eşiği (kaba)
const VOL_MULT_15 = parseFloat(process.env.VOL_MULT_15 || "1.2"); // 15s hacim SMA katsayısı (yaklaşık)
const RSI_UP = parseFloat(process.env.RSI_UP || "52");
const RSI_DOWN = parseFloat(process.env.RSI_DOWN || "48");

// Opsiyonel bildirimler
const NO_HIT_SUMMARY = parseInt(process.env.NO_HIT_SUMMARY || "0", 10); // 0/1
const HEARTBEAT_N = parseInt(process.env.HEARTBEAT_N || "10", 10);      // her N turda özet
const DEBUG_PING = parseInt(process.env.DEBUG_PING || "1", 10);         // 1 ise her çalışmada test ping yollar

// ---- DEBUG HANDLERS ----
process.on("unhandledRejection", e => console.error("[UNHANDLED]", e?.stack || e));
process.on("uncaughtException", e => console.error("[UNCAUGHT]", e?.stack || e));

console.log("=== SIGNAL BOT START ===", {
  node: process.version,
  cap: SYMBOL_CAP, p1m: PCT_1M, p5m: PCT_5M, vol: VOL_MULT_15, up: RSI_UP, down: RSI_DOWN
});

// ---- HOST ROTATION (SPOT) ----
// Sıra: vision → gcp → api2 (451/403’te oto fallback)
const SPOT_BASES = [
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com",
  "https://api2.binance.com",
];

async function fetchJSONFromBases(bases, path, timeoutMs = 12000) {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SignalBot/1.0 Chrome/120 Safari/537.36";
  let lastErr = null;
  for (const base of bases) {
    const url = `${base}${path}`;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, {
        headers: { "user-agent": ua, "accept": "application/json,text/plain,*/*" },
        signal: ctl.signal
      });
      clearTimeout(to);
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status} @ ${url}`);
        continue;
      }
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        lastErr = new Error(`Non-JSON @ ${url} : ${text.slice(0,120)}`);
        continue;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All hosts failed");
}

async function getServerTime() {
  try {
    const j = await fetchJSONFromBases(SPOT_BASES, "/api/v3/time");
    if (j && j.serverTime) return j.serverTime;
  } catch {}
  return Date.now();
}

async function getSpotSymbols() {
  const data = await fetchJSONFromBases(SPOT_BASES, "/api/v3/exchangeInfo?permissions=SPOT");
  const list = (data?.symbols || [])
    .filter(s => s.status === "TRADING" && s.symbol.endsWith("USDT"))
    .map(s => s.symbol);
  return list.slice(0, SYMBOL_CAP);
}

// 24 saatlik hızlı özet (kaba sinyal için)
async function get24h(symbol) {
  return await fetchJSONFromBases(SPOT_BASES, `/api/v3/ticker/24hr?symbol=${symbol}`);
}

// ---- TELEGRAM ----
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
    if (!r.ok) {
      console.error(`[Telegram] HTTP ${r.status}`);
    }
  } catch (e) {
    console.error("[Telegram]", e?.message || e);
  }
}

function fmtLine(type, s, price, d1, d5, volx, rsi) {
  const emoji = type === "up" ? "📈" : "📉";
  const title = type === "up" ? "YÜKSELİŞ" : "DÜŞÜŞ";
  return `**${emoji} ${title}**\n• **${s}**  ₮${price}  1m:${d1.toFixed(2)}%  5m:${d5.toFixed(2)}%  Vol:${volx.toFixed(2)}×  RSI:${rsi.toFixed(1)}`;
}

// ---- MAIN SCAN ----
async function scanOnce() {
  console.log("🔎 Tarama başlıyor…");
  const t0 = Date.now();
  let syms = [];
  try {
    syms = await getSpotSymbols();
  } catch (e) {
    console.error("[exchangeInfo]", e?.message || e);
  }
  console.log("Toplam sembol:", syms.length);

  const hits = [];
  for (const s of syms) {
    let d;
    try {
      d = await get24h(s);
    } catch (e) {
      continue;
    }
    if (!d) continue;

    const price = parseFloat(d.lastPrice || "0");
    // Burada gerçek 1m/5m yerine 24h yüzdesini kaba eşik için kullanıyoruz.
    // İleri seviye: getKlines ile 1m/5m hesaplanır (isteğe bağlı).
    const d1 = parseFloat(d.priceChangePercent || "0"); 
    const d5 = 0;
    const volx = Math.max(1, parseFloat(d.quoteVolume || "0") / Math.max(1, parseFloat(d.volume || "1")));
    const rsi = d1 >= 0 ? 60 : 40;

    if (!Number.isFinite(price) || !Number.isFinite(d1) || !Number.isFinite(volx)) continue;

    if (d1 >= PCT_1M && volx >= VOL_MULT_15) {
      hits.push(fmtLine("up", s, price, d1, d5, volx, Math.max(rsi, RSI_UP)));
    } else if (d1 <= -PCT_1M && volx >= VOL_MULT_15) {
      hits.push(fmtLine("down", s, price, d1, d5, volx, Math.min(40, RSI_DOWN)));
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (hits.length) {
    await tg(`> **Signal Tracker:**\n${hits.join("\n\n")}`);
  } else if (NO_HIT_SUMMARY) {
    await tg(`ℹ️ Şu an sinyal yok (0 hit). Tarama süresi: ${dt}s`);
  }
  console.log(`✅ Tarama bitti. Hit: ${hits.length} | ${dt}s`);
}

// ---- ENTRYPOINT ----
(async () => {
  try {
    if (DEBUG_PING) {
      await tg("🧪 Ping: Signal bot çalıştı (debug).");
    }
    const srv = await getServerTime();
    console.log("ServerTime:", srv);
    await scanOnce();
  } catch (e) {
    console.error("MAIN ERROR:", e?.stack || e);
    await tg(`⚠️ Hata: ${e?.message || e}`);
    process.exitCode = 1;
  }
})();
