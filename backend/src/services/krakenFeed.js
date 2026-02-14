// backend/src/services/krakenFeed.js
// Phase 2 — Hardened Institutional Feed Layer
// Self-healing • Watchdog protected • Backoff jitter • Stable reconnection
// Emits: { type:'tick', symbol, price, ts }

const WebSocket = require("ws");

/* =========================================================
   CONFIG
========================================================= */

const URL = "wss://ws.kraken.com";
const STALE_TIMEOUT_MS = 20000;
const WATCHDOG_INTERVAL = 5000;
const MAX_BACKOFF_MS = 20000;
const BASE_BACKOFF_MS = 1500;
const MAX_MESSAGE_SIZE = 1_000_000;

/* =========================================================
   PUBLIC START
========================================================= */

function startKrakenFeed({ onTick, onStatus }) {
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
  let watchdog = null;

  let backoffMs = BASE_BACKOFF_MS;
  let lastMsgAt = 0;
  let connectedAt = 0;

  const lastEmit = Object.create(null);
  const EMIT_INTERVAL = 250;

  /* ================= HELPERS ================= */

  function safeStatus(s) {
    try { onStatus && onStatus(s); } catch {}
  }

  function clearTimers() {
    if (watchdog) clearInterval(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    watchdog = null;
    reconnectTimer = null;
  }

  function cleanupSocket() {
    try { ws && ws.removeAllListeners(); } catch {}
    ws = null;
  }

  function jitter(ms) {
    return ms + Math.floor(Math.random() * 300);
  }

  /* ================= RECONNECT ================= */

  function scheduleReconnect(reason) {
    if (closedByUs) return;

    safeStatus(`reconnecting:${reason || "unknown"}`);

    const wait = jitter(backoffMs);
    backoffMs = Math.min(Math.floor(backoffMs * 1.5), MAX_BACKOFF_MS);

    clearTimers();
    reconnectTimer = setTimeout(connect, wait);
  }

  /* ================= CONNECT ================= */

  function connect() {
    clearTimers();
    cleanupSocket();

    safeStatus("connecting");

    ws = new WebSocket(URL, {
      maxPayload: MAX_MESSAGE_SIZE,
    });

    ws.on("open", () => {
      connectedAt = Date.now();
      lastMsgAt = Date.now();
      backoffMs = BASE_BACKOFF_MS;

      safeStatus("connected");

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

      if (!buf || buf.length > MAX_MESSAGE_SIZE) return;

      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Ignore system / heartbeat objects
      if (msg && typeof msg === "object" && !Array.isArray(msg)) return;
      if (!Array.isArray(msg)) return;

      const data = msg[1];
      const pair = typeof msg[3] === "string" ? msg[3] : null;
      if (!data || !pair) return;

      const lastStr = data?.c?.[0];
      const price = Number(lastStr);
      if (!Number.isFinite(price)) return;

      const symbol = MAP[pair] || pair;
      const now = Date.now();

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
      if (!closedByUs) scheduleReconnect("close");
    });

    ws.on("error", () => {
      safeStatus("error");
      try { ws && ws.terminate(); } catch {}
    });

    /* ================= WATCHDOG ================= */

    watchdog = setInterval(() => {
      if (closedByUs) return;

      const now = Date.now();

      // stale feed detection
      if (now - lastMsgAt > STALE_TIMEOUT_MS) {
        safeStatus("stale");
        try { ws && ws.terminate(); } catch {}
        return;
      }

      // connection sanity check
      if (connectedAt && now - connectedAt > 60000) {
        // reset backoff if stable for 60s+
        backoffMs = BASE_BACKOFF_MS;
      }
    }, WATCHDOG_INTERVAL);
  }

  /* ================= START ================= */

  connect();

  /* ================= PUBLIC API ================= */

  return {
    stop() {
      closedByUs = true;
      clearTimers();
      try { ws && ws.close(); } catch {}
      cleanupSocket();
      safeStatus("stopped");
    },
  };
}

module.exports = { startKrakenFeed };
