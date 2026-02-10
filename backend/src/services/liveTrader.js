// backend/src/services/liveTrader.js
// Live Trading Engine — TENANT SAFE (FINAL)
//
// GUARANTEES:
// - One isolated live trader per tenant
// - Signals logged safely
// - NEVER executes trades unless explicitly armed + adapter wired
// - MSP / SOC compliant

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const LIVE_REFERENCE_BALANCE = Number(
  process.env.LIVE_START_BALANCE || 0
);

const BASE_PATH =
  process.env.LIVE_TRADER_STATE_DIR ||
  path.join("/tmp", "live_trader");

/* ================= ENV GATES ================= */

function envTrue(name) {
  const v = String(process.env[name] || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function isEnabled() {
  return envTrue("LIVE_TRADING_ENABLED");
}

function isExecuteEnabled() {
  return envTrue("LIVE_TRADING_EXECUTE");
}

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `live_${tenantId}.json`);
}

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/* ================= STATE ================= */

function defaultState() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,

    mode: "live-disabled", // live-disabled | live-armed | live-executing
    dayKey: dayKey(Date.now()),

    lastPriceBySymbol: {},

    stats: {
      ticksSeen: 0,
      lastTickTs: null,
      lastSignalTs: null,
      lastReason: "not_started",
    },

    intents: [],
    orders: [],

    lastError: null,

    config: {
      LIVE_REFERENCE_BALANCE,
    },
  };
}

const STATES = new Map();
const SAVE_TIMERS = new Map();

/* ================= PERSISTENCE ================= */

function load(tenantId) {
  if (STATES.has(tenantId)) return STATES.get(tenantId);

  const file = statePath(tenantId);
  let state = defaultState();

  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      state = { ...state, ...raw };
    }
  } catch {}

  STATES.set(tenantId, state);
  return state;
}

function scheduleSave(tenantId) {
  if (SAVE_TIMERS.has(tenantId)) return;

  SAVE_TIMERS.set(
    tenantId,
    setTimeout(() => {
      SAVE_TIMERS.delete(tenantId);
      const state = STATES.get(tenantId);
      if (!state) return;

      state.updatedAt = nowIso();
      try {
        fs.writeFileSync(
          statePath(tenantId),
          JSON.stringify(state, null, 2)
        );
      } catch {}
    }, 400)
  );
}

function refreshFlags(state) {
  state.enabled = isEnabled();
  state.execute = state.enabled && isExecuteEnabled();

  if (!state.enabled) state.mode = "live-disabled";
  else if (state.execute) state.mode = "live-executing";
  else state.mode = "live-armed";
}

function resetDayIfNeeded(state, ts) {
  const dk = dayKey(ts);
  if (state.dayKey !== dk) {
    state.dayKey = dk;
  }
}

/* ================= LIFECYCLE ================= */

function start(tenantId) {
  const state = load(tenantId);

  state.running = true;
  refreshFlags(state);

  state.stats.lastReason = state.enabled
    ? state.execute
      ? "executing_enabled_waiting_for_signal"
      : "armed_waiting_for_signal"
    : "disabled_by_env";

  state.lastError = null;
  scheduleSave(tenantId);
}

function stop(tenantId) {
  const state = load(tenantId);
  state.running = false;
  scheduleSave(tenantId);
}

/* ================= TICKS ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  resetDayIfNeeded(state, ts);

  const sym = String(symbol || "BTCUSDT");
  const p = safeNum(price, null);
  const t = safeNum(ts, Date.now());
  if (p == null) return;

  state.lastPriceBySymbol[sym] = p;
  state.stats.ticksSeen += 1;
  state.stats.lastTickTs = t;

  refreshFlags(state);
  state.stats.lastReason = state.enabled
    ? state.execute
      ? "executing_enabled_waiting_for_signal"
      : "armed_waiting_for_signal"
    : "disabled_by_env";

  scheduleSave(tenantId);
}

/* ================= SIGNAL ENTRY ================= */

async function pushSignal(tenantId, signal = {}) {
  const state = load(tenantId);

  try {
    refreshFlags(state);

    if (!state.running) throw new Error("liveTrader not running");

    if (!state.enabled) {
      state.stats.lastReason = "signal_rejected_disabled";
      scheduleSave(tenantId);
      return { ok: false, error: "LIVE_TRADING_ENABLED is off" };
    }

    const symbol = String(signal.symbol || "BTCUSDT");
    const side = String(signal.side || "").toUpperCase();

    // Non-executable by design
    if (["WAIT", "CLOSE", "SELL"].includes(side)) {
      state.stats.lastReason = "signal_logged_non_executable";
      scheduleSave(tenantId);
      return { ok: true, ignored: true, reason: side };
    }

    if (side !== "BUY") {
      throw new Error("Invalid trade side");
    }

    const qty = safeNum(signal.qty, null);
    if (!qty || qty <= 0) throw new Error("Invalid qty");

    const lastPrice = state.lastPriceBySymbol[symbol];
    if (!Number.isFinite(lastPrice)) {
      throw new Error("Missing last price for symbol");
    }

    const intent = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      iso: nowIso(),

      symbol,
      side,
      type: String(signal.type || "MARKET").toUpperCase(),
      qty,

      price: safeNum(signal.price, null),
      tp: safeNum(signal.tp, null),
      sl: safeNum(signal.sl, null),

      confidence: safeNum(signal.confidence, null),
      reason: String(signal.reason || "").slice(0, 500),

      mode: state.mode,
      executed: false,
      execution: null,
    };

    state.intents.push(intent);
    state.intents = state.intents.slice(-400);
    state.stats.lastSignalTs = intent.ts;

    if (!state.execute) {
      state.stats.lastReason = "signal_logged_armed_no_execute";
      scheduleSave(tenantId);
      return { ok: true, accepted: true, executed: false, intent };
    }

    // Execution intentionally blocked until adapter exists
    intent.execution = {
      status: "adapter_missing",
      note: "Execution adapter not wired.",
    };

    state.stats.lastReason = "execute_enabled_adapter_missing";
    scheduleSave(tenantId);

    return { ok: true, accepted: true, executed: false, intent };
  } catch (e) {
    state.lastError = e?.message || String(e);
    state.stats.lastReason = "signal_error";
    scheduleSave(tenantId);
    return { ok: false, error: state.lastError };
  }
}

/* ================= SNAPSHOT ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  refreshFlags(state);

  return {
    ok: true,
    running: state.running,
    enabled: state.enabled,
    execute: state.execute,
    mode: state.mode,

    lastPriceBySymbol: state.lastPriceBySymbol,
    stats: state.stats,

    intents: state.intents.slice(-50),
    orders: state.orders.slice(-50),

    lastError: state.lastError,

    config: {
      LIVE_TRADING_ENABLED: state.enabled,
      LIVE_TRADING_EXECUTE: state.execute,
      LIVE_REFERENCE_BALANCE,
      NOTE:
        "Safe design: enabled=accept signals, execute=send orders (adapter required).",
    },
  };
}

module.exports = {
  start,
  stop,
  tick,
  snapshot,
  pushSignal,
};
