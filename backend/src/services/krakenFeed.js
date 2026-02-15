// backend/src/services/krakenFeed.js
// Phase 25 — Institutional Market Data Engine
// Self-Healing • Symbol Stale Detection • Regime Tagging
// Volatility Pulse • Feed Health Score • AI-Ready
// Kill-Switch • Backoff Hardened • Production Grade

const WebSocket = require("ws");

/* =========================================================
   CONFIG
========================================================= */

const URL = "wss://ws.kraken.com";

const FEED_ENABLED =
  String(process.env.KRAKEN_FEED_ENABLED || "true")
    .toLowerCase() !== "false";

const STALE_TIMEOUT_MS = Number(
  process.env.KRAKEN_STALE_TIMEOUT_MS || 20000
);

const SYMBOL_STALE_MS = Number(
  process.env.KRAKEN_SYMBOL_STALE_MS || 15000
);

const WATCHDOG_INTERVAL = 5000;
const PING_INTERVAL = 15000;

const MAX_BACKOFF_MS = 20000;
const BASE_BACKOFF_MS = 1500;

const MAX_MESSAGE_SIZE = 1_000_000;
const EMIT_INTERVAL = 200;
const MAX_TICKS_PER_SECOND = 1500;

/* =========================================================
   SYMBOL CONFIG
========================================================= */

function getPairs() {
  const raw = String(
    process.env.KRAKEN_PAIRS ||
      "XBT/USD,ETH/USD,SOL/USD,XRP/USD"
  );

  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function buildMap(pairs) {
  const map = {};
  for (const p of pairs) {
    const base = p.split("/")[0];
    map[p] = base.replace("XBT", "BTC") + "USDT";
  }
  return map;
}

/* =========================================================
   START
========================================================= */

function startKrakenFeed({ onTick, onStatus }) {

  if (!FEED_ENABLED) {
    onStatus && onStatus("disabled");
    return {
      stop() {},
      getMetrics() { return { disabled: true }; },
      getHealth() { return { disabled: true }; },
    };
  }

  const PAIRS = getPairs();
  const MAP = buildMap(PAIRS);

  let ws = null;
  let closedByUs = false;
  let reconnectTimer = null;
  let watchdog = null;
  let pingTimer = null;

  let backoffMs = BASE_BACKOFF_MS;
  let lastMsgAt = 0;
  let connectedAt = 0;

  const lastEmit = Object.create(null);
  const lastSymbolTick = Object.create(null);
  const lastSymbolPrice = Object.create(null);

  let ticksThisSecond = 0;
  let lastSecond = Math.floor(Date.now() / 1000);

  const metrics = {
    connects: 0,
    reconnects: 0,
    ticks: 0,
    staleEvents: 0,
    symbolStaleEvents: 0,
    pingsSent: 0,
  };

  let volatilityPulse = 0;
  let regime = "normal";

  /* =========================================================
     HELPERS
  ========================================================= */

  function safeStatus(s) {
    try { onStatus && onStatus(s); } catch {}
  }

  function clearTimers() {
    if (watchdog) clearInterval(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    watchdog = reconnectTimer = pingTimer = null;
  }

  function cleanupSocket() {
    try { ws && ws.removeAllListeners(); } catch {}
    ws = null;
  }

  function jitter(ms) {
    return ms + Math.floor(Math.random() * 400);
  }

  function resetTickCounter() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== lastSecond) {
      lastSecond = nowSec;
      ticksThisSecond = 0;
    }
  }

  function updateVolatility(symbol, price) {
    const last = lastSymbolPrice[symbol];
    if (!last) {
      lastSymbolPrice[symbol] = price;
      return;
    }

    const change = Math.abs(price - last) / last;

    volatilityPulse =
      volatilityPulse * 0.9 + change * 0.1;

    if (volatilityPulse > 0.02) regime = "high_vol";
    else if (volatilityPulse < 0.005) regime = "low_vol";
    else regime = "normal";

    lastSymbolPrice[symbol] = price;
  }

  /* =========================================================
     RECONNECT
  ========================================================= */

  function scheduleReconnect(reason) {
    if (closedByUs) return;

    metrics.reconnects++;
    safeStatus(`reconnecting:${reason || "unknown"}`);

    const wait = jitter(backoffMs);
    backoffMs = Math.min(
      Math.floor(backoffMs * 1.5),
      MAX_BACKOFF_MS
    );

    clearTimers();
    reconnectTimer = setTimeout(connect, wait);
  }

  /* =========================================================
     CONNECT
  ========================================================= */

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

      ws.send(JSON.stringify({
        event: "subscribe",
        pair: PAIRS,
        subscription: { name: "ticker" },
      }));

      pingTimer = setInterval(() => {
        try {
          ws.ping();
          metrics.pingsSent++;
        } catch {}
      }, PING_INTERVAL);
    });

    ws.on("pong", () => {
      lastMsgAt = Date.now();
    });

    ws.on("message", (buf) => {

      lastMsgAt = Date.now();

      if (!buf || buf.length > MAX_MESSAGE_SIZE) return;

      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch { return; }

      if (!Array.isArray(msg)) return;

      const data = msg[1];
      const pair = msg[3];
      if (!data || !pair) return;

      const price = Number(data?.c?.[0]);
      if (!Number.isFinite(price)) return;

      const symbol = MAP[pair] || pair;
      const now = Date.now();

      resetTickCounter();
      ticksThisSecond++;
      if (ticksThisSecond > MAX_TICKS_PER_SECOND) return;

      if (
        lastEmit[symbol] &&
        now - lastEmit[symbol] < EMIT_INTERVAL
      ) return;

      lastEmit[symbol] = now;
      lastSymbolTick[symbol] = now;

      updateVolatility(symbol, price);

      metrics.ticks++;

      try {
        onTick && onTick({
          type: "tick",
          symbol,
          price,
          ts: now,
          regime,
          volatilityPulse,
        });
      } catch {}
    });

    ws.on("close", () => {
      safeStatus("closed");
      if (!closedByUs) scheduleReconnect("close");
    });

    ws.on("error", () => {
      safeStatus("error");
      try { ws.terminate(); } catch {}
    });

    /* =========================================================
       WATCHDOG
    ========================================================= */

    watchdog = setInterval(() => {

      if (closedByUs) return;

      const now = Date.now();

      /* ---- Global Stale ---- */

      if (now - lastMsgAt > STALE_TIMEOUT_MS) {
        metrics.staleEvents++;
        safeStatus("stale_global");
        try { ws.terminate(); } catch {}
      }

      /* ---- Symbol Stale Detection ---- */

      for (const s of Object.keys(lastSymbolTick)) {
        if (now - lastSymbolTick[s] > SYMBOL_STALE_MS) {
          metrics.symbolStaleEvents++;
          safeStatus(`symbol_stale:${s}`);
        }
      }

      /* ---- Reset Backoff After Stability ---- */

      if (connectedAt && now - connectedAt > 60000) {
        backoffMs = BASE_BACKOFF_MS;
      }

    }, WATCHDOG_INTERVAL);
  }

  /* =========================================================
     START
  ========================================================= */

  connect();

  /* =========================================================
     API
  ========================================================= */

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
        uptimeMs: connectedAt
          ? Date.now() - connectedAt
          : 0,
        volatilityPulse,
        regime,
      };
    },

    getHealth() {

      const now = Date.now();

      const globalHealthy =
        now - lastMsgAt <= STALE_TIMEOUT_MS;

      const symbolHealth = {};
      for (const s of Object.keys(lastSymbolTick)) {
        symbolHealth[s] =
          now - lastSymbolTick[s] <= SYMBOL_STALE_MS;
      }

      const healthScore =
        globalHealthy
          ? 1 - Math.min(metrics.staleEvents / 20, 0.5)
          : 0;

      return {
        connected: !!ws,
        globalHealthy,
        symbolHealth,
        healthScore: Math.max(0, healthScore),
        regime,
        volatilityPulse,
        metrics,
      };
    },
  };
}

module.exports = { startKrakenFeed };
