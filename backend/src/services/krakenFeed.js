// backend/src/services/krakenFeed.js
// Kraken Public WebSocket feed (prices only, no keys)
// Emits: { type:'tick', symbol:'BTCUSDT', price:Number, ts:Number }

const WebSocket = require("ws");

function startKrakenFeed({ onTick, onStatus }) {
  // Use newer endpoint (more stable)
  const URL = "wss://ws.kraken.com";

  // Kraken USD pairs (public)
  const PAIRS = [
    "XBT/USD",
    "ETH/USD",
    "SOL/USD",
    "XRP/USD",
    "ADA/USD",
    "DOT/USD",
    "LINK/USD",
    "LTC/USD",
    "BCH/USD",
    "XLM/USD",
  ];

  // Internal normalization (YES, still called USDT internally — intentional)
  const MAP = {
    "XBT/USD": "BTCUSDT",
    "ETH/USD": "ETHUSDT",
    "SOL/USD": "SOLUSDT",
    "XRP/USD": "XRPUSDT",
    "ADA/USD": "ADAUSDT",
    "DOT/USD": "DOTUSDT",
    "LINK/USD": "LINKUSDT",
    "LTC/USD": "LTCUSDT",
    "BCH/USD": "BCHUSDT",
    "XLM/USD": "XLMUSDT",
  };

  let ws = null;
  let closedByUs = false;

  let reconnectTimer = null;
  let backoffMs = 1500;

  let lastMsgAt = 0;
  let watchdog = null;

  // Throttle per symbol (ms)
  const lastEmit = Object.create(null);
  const EMIT_INTERVAL = 250; // 4 ticks/sec max per symbol

  function safeStatus(s) {
    try {
      onStatus && onStatus(s);
    } catch {}
  }

  function clearTimers() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function cleanupSocket() {
    if (ws) {
      try {
        ws.removeAllListeners();
      } catch {}
    }
    ws = null;
  }

  function scheduleReconnect() {
    if (closedByUs) return;

    safeStatus("reconnecting");
    const wait = backoffMs;
    backoffMs = Math.min(Math.floor(backoffMs * 1.4), 15000);

    clearTimers();
    reconnectTimer = setTimeout(connect, wait);
  }

  function connect() {
    clearTimers();
    cleanupSocket();

    safeStatus("connecting");
    ws = new WebSocket(URL);

    ws.on("open", () => {
      safeStatus("connected");
      backoffMs = 1500;
      lastMsgAt = Date.now();

      try {
        ws.send(
          JSON.stringify({
            event: "subscribe",
            pair: PAIRS,
            subscription: { name: "ticker" },
          })
        );
      } catch {}
    });

    ws.on("message", (buf) => {
      lastMsgAt = Date.now();

      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Ignore event objects
      if (msg && typeof msg === "object" && !Array.isArray(msg)) return;
      if (!Array.isArray(msg)) return;

      const data = msg[1];
      const pair = msg[3] || msg[2]; // defensive
      if (!data || !pair) return;

      const lastStr = data?.c?.[0];
      const price = Number(lastStr);
      if (!Number.isFinite(price)) return;

      const symbol = MAP[pair] || pair;
      const now = Date.now();

      // Throttle
      if (lastEmit[symbol] && now - lastEmit[symbol] < EMIT_INTERVAL) return;
      lastEmit[symbol] = now;

      try {
        onTick &&
          onTick({
            type: "tick",
            symbol,
            price,
            ts: now,
          });
      } catch {}
    });

    ws.on("close", () => {
      safeStatus("closed");
      if (!closedByUs) scheduleReconnect();
    });

    ws.on("error", () => {
      safeStatus("error");
      try {
        ws && ws.terminate();
      } catch {}
    });

    // Watchdog: force reconnect if silent
    watchdog = setInterval(() => {
      if (closedByUs) return;
      if (Date.now() - lastMsgAt > 20000) {
        safeStatus("stale");
        try {
          ws && ws.terminate();
        } catch {}
      }
    }, 5000);
  }

  connect();

  return {
    stop() {
      closedByUs = true;
      try {
        ws && ws.close();
      } catch {}
      clearTimers();
      cleanupSocket();
    },
  };
}

module.exports = { startKrakenFeed };
