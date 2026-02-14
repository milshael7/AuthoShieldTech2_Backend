// backend/src/services/krakenFeed.js
// Phase 9 — Institutional Market Data Engine (Upgraded)
// Self-healing • Watchdog+ • Symbol stale guard • Telemetry enabled
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

const EMIT_INTERVAL = 250;
const MAX_TICKS_PER_SECOND = 1000;

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
  const lastSymbolTick = Object.create(null);

  let ticksThisSecond = 0;
  let lastSecond = Math.floor(Date.now() / 1000);

  const metrics = {
    connects: 0,
    reconnects: 0,
    ticks: 0,
    lastTickAt: 0,
    staleEvents: 0,
  };

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

  function resetTickCounter() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== lastSecond) {
      lastSecond = nowSec;
      ticksThisSecond = 0;
    }
  }

  /* ================= RECONNECT ================= */

  function scheduleReconnect(reason) {
    if (closedByUs) return;

    metrics.reconnects++;
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
      metrics.connects++;
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

      /* ---- Tick Rate Guard ---- */
      resetTickCounter();
      ticksThisSecond++;
      if (ticksThisSecond > MAX_TICKS_PER_SECOND) return;

      /* ---- Emit Throttle ---- */
      if (lastEmit[symbol] && now - lastEmit[symbol] < EMIT_INTERVAL) return;
      lastEmit[symbol] = now;

      metrics.ticks++;
      metrics.lastTickAt = now;
      lastSymbolTick[symbol] = now;

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

      /* ---- Global Stale ---- */
      if (now - lastMsgAt > STALE_TIMEOUT_MS) {
        metrics.staleEvents++;
        safeStatus("stale_global");
        try { ws && ws.terminate(); } catch {}
        return;
      }

      /* ---- Per Symbol Stale ---- */
      for (const s of Object.keys(lastSymbolTick)) {
        if (now - lastSymbolTick[s] > STALE_TIMEOUT_MS) {
          metrics.staleEvents++;
          safeStatus(`stale_symbol:${s}`);
        }
      }

      /* ---- Reset Backoff if Stable ---- */
      if (connectedAt && now - connectedAt > 60000) {
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

    getMetrics() {
      return {
        ...metrics,
        uptimeMs: Date.now() - connectedAt,
      };
    },
  };
}

module.exports = { startKrakenFeed };
