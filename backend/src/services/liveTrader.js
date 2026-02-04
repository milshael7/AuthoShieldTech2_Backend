// backend/src/services/liveTrader.js
// Live trading engine (SAFE by default)
// - Receives Kraken ticks (already wired in server.js)
// - Can be "armed" without sending orders (intent logging only)
// - Optional execute mode if you later add Kraken credentials
// - Persists state to disk so it DOES NOT RESET on deploy (use Render Disk)

const fs = require("fs");
const path = require("path");

const START_BAL = Number(process.env.LIVE_START_BALANCE || 0);

// Persist state here (IMPORTANT: set this to Render Disk mount, not /tmp)
const STATE_PATH =
  (process.env.LIVE_TRADER_STATE_PATH && String(process.env.LIVE_TRADER_STATE_PATH).trim()) ||
  "/tmp/live_trader_state.json";

// Gate #1: allow the live engine to run / accept signals
function isEnabled() {
  const v = String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

// Gate #2: allow real orders to be transmitted to exchange (OFF unless explicitly enabled)
function isExecuteEnabled() {
  const v = String(process.env.LIVE_TRADING_EXECUTE || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

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

function loadState() {
  try {
    ensureDirFor(STATE_PATH);
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    ensureDirFor(STATE_PATH);
    const tmp = STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch {}
}

function defaultState() {
  return {
    version: 2,
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
      lastReason: "not_started",
      lastSignalTs: null,
    },

    // We store "intents" here (unified format). Even in execute mode,
    // intents are written first, then execution happens.
    intents: [],

    // placeholder (later: filled with exchange order ids / statuses)
    orders: [],

    lastError: null,

    config: {
      LIVE_START_BALANCE: START_BAL,
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
  }, 500);
}

function refreshFlags() {
  state.enabled = isEnabled();
  state.execute = state.enabled && isExecuteEnabled();

  if (!state.enabled) state.mode = "live-disabled";
  else if (state.execute) state.mode = "live-executing";
  else state.mode = "live-armed";
}

function start() {
  // load persisted state (so it doesn't reset every deploy)
  const persisted = loadState();
  if (persisted && persisted.version >= 1) {
    state = { ...defaultState(), ...persisted };
  }

  state.running = true;
  refreshFlags();

  state.stats.lastReason = state.enabled
    ? (state.execute ? "executing_enabled_waiting_for_signal" : "armed_waiting_for_signal")
    : "disabled_by_env";

  state.lastError = null;
  scheduleSave();
}

// Receive Kraken ticks (already wired)
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

  if (!state.enabled) {
    state.stats.lastReason = "disabled_by_env";
    scheduleSave();
    return;
  }

  // Live trader does NOT invent trades on its own.
  // It waits for a "signal" pushed from your strategy/brain layer.
  state.stats.lastReason = state.execute
    ? "executing_enabled_waiting_for_signal"
    : "armed_waiting_for_signal";

  scheduleSave();
}

/**
 * pushSignal(signal)
 * This is the ONE entry point we will use for BOTH paper + live later.
 * Your brain/strategy decides, then pushes signal here.
 *
 * signal = {
 *   symbol: "BTCUSDT",
 *   side: "BUY"|"SELL",
 *   type: "MARKET"|"LIMIT"|"STOP",
 *   qty: number,
 *   price?: number,
 *   tp?: number,
 *   sl?: number,
 *   reason?: string,
 *   confidence?: number (0..1)
 * }
 */
async function pushSignal(signal = {}) {
  try {
    refreshFlags();

    if (!state.running) throw new Error("liveTrader not running");
    if (!state.enabled) {
      state.stats.lastReason = "signal_rejected_disabled_by_env";
      scheduleSave();
      return { ok: false, error: "LIVE_TRADING_ENABLED is off" };
    }

    const sym = String(signal.symbol || "BTCUSDT");
    const side = String(signal.side || "").toUpperCase();
    const type = String(signal.type || "MARKET").toUpperCase();

    const qty = safeNum(signal.qty, null);
    const px = safeNum(signal.price, null);
    const conf = safeNum(signal.confidence, null);

    if (!(side === "BUY" || side === "SELL")) throw new Error("Invalid side");
    if (!qty || qty <= 0) throw new Error("Invalid qty");

    const intent = {
      id: String(Date.now()) + "_" + Math.random().toString(16).slice(2),
      ts: Date.now(),
      iso: nowIso(),

      symbol: sym,
      side,
      type,
      qty,

      price: px, // optional (for LIMIT/STOP)
      tp: safeNum(signal.tp, null),
      sl: safeNum(signal.sl, null),

      confidence: conf,
      reason: String(signal.reason || "").slice(0, 500),

      mode: state.mode,
      executed: false,
      execution: null,
    };

    state.intents.push(intent);
    state.intents = state.intents.slice(-400); // bounded
    state.stats.lastSignalTs = intent.ts;

    // If execute is OFF, we stop right here (SAFE).
    if (!state.execute) {
      state.stats.lastReason = "signal_accepted_armed_no_execute";
      scheduleSave();
      return { ok: true, accepted: true, executed: false, intent };
    }

    // EXECUTE MODE (we still do nothing until Kraken adapter is added properly)
    // For now we keep it safe and mark as "needs_adapter".
    intent.executed = false;
    intent.execution = { status: "needs_kraken_adapter", note: "Add Kraken REST adapter + signing before real orders." };
    state.stats.lastReason = "signal_accepted_execute_on_but_no_adapter";
    scheduleSave();

    return { ok: true, accepted: true, executed: false, intent };
  } catch (e) {
    state.lastError = e?.message || String(e);
    state.stats.lastReason = "signal_error";
    scheduleSave();
    return { ok: false, error: state.lastError };
  }
}

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
      LIVE_START_BALANCE: START_BAL,
      LIVE_TRADER_STATE_PATH: STATE_PATH,
      NOTE:
        "Safe design: enabled=accept signals, execute=allow sending orders. Execution adapter not added yet.",
    },
  };
}

module.exports = {
  start,
  tick,
  snapshot,
  pushSignal,
};
