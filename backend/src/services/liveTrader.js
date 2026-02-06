// backend/src/services/liveTrader.js
// Live trading engine (SAFE by default)
// Accepts signals, logs intents, NEVER trades unless explicitly armed.

const fs = require("fs");
const path = require("path");

const LIVE_REFERENCE_BALANCE = Number(process.env.LIVE_START_BALANCE || 0);

// Persist state here (use Render Disk, NOT /tmp in production)
const STATE_PATH =
  (process.env.LIVE_TRADER_STATE_PATH && String(process.env.LIVE_TRADER_STATE_PATH).trim()) ||
  "/tmp/live_trader_state.json";

// ---------------- ENV GATES ----------------
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

// ---------------- HELPERS ----------------
function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------- STATE ----------------
function defaultState() {
  return {
    version: 3,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    running: false,
    enabled: false,
    execute: false,

    mode: "live-disabled", // live-disabled | live-armed | live-executing
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
      STATE_PATH,
    },
  };
}

let state = defaultState();
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.updatedAt = nowIso();
    saveState(state);
  }, 400);
}

function saveState(s) {
  try {
    ensureDirFor(STATE_PATH);
    const tmp = STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch {}
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function refreshFlags() {
  state.enabled = isEnabled();
  state.execute = state.enabled && isExecuteEnabled();

  if (!state.enabled) state.mode = "live-disabled";
  else if (state.execute) state.mode = "live-executing";
  else state.mode = "live-armed";
}

// ---------------- LIFECYCLE ----------------
function start() {
  const persisted = loadState();
  if (persisted && persisted.version >= 1) {
    state = {
      ...defaultState(),
      ...persisted,
      stats: { ...defaultState().stats, ...(persisted.stats || {}) },
    };
  }

  state.running = true;
  refreshFlags();

  state.stats.lastReason = state.enabled
    ? state.execute
      ? "executing_enabled_waiting_for_signal"
      : "armed_waiting_for_signal"
    : "disabled_by_env";

  state.lastError = null;
  scheduleSave();
}

// ---------------- TICKS ----------------
function tick(symbol, price, ts) {
  if (!state.running) return;

  const sym = String(symbol || "BTCUSDT");
  const p = safeNum(price, null);
  const t = safeNum(ts, Date.now());

  if (p == null) return;

  state.lastPriceBySymbol[sym] = p;
  state.stats.ticksSeen += 1;
  state.stats.lastTickTs = t;

  refreshFlags();
  state.stats.lastReason = state.enabled
    ? state.execute
      ? "executing_enabled_waiting_for_signal"
      : "armed_waiting_for_signal"
    : "disabled_by_env";

  scheduleSave();
}

// ---------------- SIGNAL ENTRY POINT ----------------
async function pushSignal(signal = {}) {
  try {
    refreshFlags();

    if (!state.running) throw new Error("liveTrader not running");
    if (!state.enabled) {
      state.stats.lastReason = "signal_rejected_disabled";
      scheduleSave();
      return { ok: false, error: "LIVE_TRADING_ENABLED is off" };
    }

    const side = String(signal.side || "").toUpperCase();

    // WAIT / CLOSE are valid but non-executable
    if (side === "WAIT" || side === "CLOSE") {
      state.stats.lastReason = "signal_logged_non_executable";
      scheduleSave();
      return { ok: true, ignored: true, reason: side };
    }

    if (!(side === "BUY" || side === "SELL")) {
      throw new Error("Invalid trade side");
    }

    const qty = safeNum(signal.qty, null);
    if (!qty || qty <= 0) throw new Error("Invalid qty");

    const intent = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      iso: nowIso(),

      symbol: String(signal.symbol || "BTCUSDT"),
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
      scheduleSave();
      return { ok: true, accepted: true, executed: false, intent };
    }

    intent.execution = {
      status: "adapter_missing",
      note: "Kraken execution adapter not wired yet.",
    };

    state.stats.lastReason = "execute_enabled_adapter_missing";
    scheduleSave();

    return { ok: true, accepted: true, executed: false, intent };
  } catch (e) {
    state.lastError = e?.message || String(e);
    state.stats.lastReason = "signal_error";
    scheduleSave();
    return { ok: false, error: state.lastError };
  }
}

// ---------------- SNAPSHOT ----------------
function snapshot() {
  refreshFlags();
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
      STATE_PATH,
      NOTE:
        "Safe design: enabled=accept signals, execute=send orders (adapter required).",
    },
  };
}

module.exports = {
  start,
  tick,
  snapshot,
  pushSignal,
};
