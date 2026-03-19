// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v51.0 (Single-Trade Controller + Manual Protection + Real SL/TP Enforcement)
// Matched to tradeBrain v22 + executionEngine v26
// ==========================================================

const { makeDecision } = require("./tradeBrain");
const executionEngine = require("./executionEngine");

/* =========================================================
CONFIG
========================================================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const COOLDOWN_AFTER_TRADE =
  Number(process.env.TRADE_COOLDOWN_AFTER_TRADE || 30000);

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 100);

const MAX_DAILY_LOSSES =
  Number(process.env.TRADE_MAX_DAILY_LOSSES || 50);

const MIN_HOLD_TIME =
  Number(process.env.TRADE_MIN_HOLD_MS || 15000);

const MIN_TRADE_DURATION =
  Number(process.env.TRADE_MIN_DURATION_MS || 2 * 60 * 1000);

const MAX_TRADE_DURATION =
  Number(process.env.TRADE_MAX_DURATION_MS || 20 * 60 * 1000);

const MAX_EXTENSION_DURATION =
  Number(process.env.TRADE_MAX_EXTENSION_MS || 15 * 60 * 1000);

const HARD_STOP_LOSS =
  Number(process.env.TRADE_HARD_STOP_LOSS || -0.0045);

const MIN_PROFIT_TO_TRAIL =
  Number(process.env.TRADE_MIN_PROFIT_TO_TRAIL || 0.0025);

const TAKE_PROFIT_PCT =
  Number(process.env.TRADE_SCALP_TAKE_PROFIT || 0.0035);

const BREAK_EVEN_TRIGGER =
  Number(process.env.TRADE_SCALP_BREAK_EVEN_TRIGGER || 0.0018);

const LOCKED_PROFIT_PCT =
  Number(process.env.TRADE_SCALP_LOCKED_PROFIT_PCT || 0.40);

const RUNNER_MIN_PROFIT =
  Number(process.env.TRADE_RUNNER_MIN_PROFIT || 0.0040);

const RUNNER_GIVEBACK_PCT =
  Number(process.env.TRADE_RUNNER_GIVEBACK_PCT || 0.35);

const WARNING_PULLBACK_PCT =
  Number(process.env.TRADE_WARNING_PULLBACK_PCT || 0.0012);

const LOSS_STREAK_SLOWDOWN =
  Number(process.env.TRADE_LOSS_STREAK_SLOWDOWN || 3);

const EXTRA_COOLDOWN_ON_LOSS_STREAK =
  Number(process.env.TRADE_EXTRA_COOLDOWN_ON_LOSS_STREAK || 90000);

const DUPLICATE_TICK_WINDOW_MS =
  Number(process.env.TRADE_DUPLICATE_TICK_WINDOW_MS || 250);

const MANUAL_PROTECT_DEFAULT_TRAIL_PCT =
  Number(process.env.TRADE_MANUAL_PROTECT_TRAIL_PCT || 0.0018);

/* =========================================================
STATE
========================================================= */

function defaultProtectionState() {
  return {
    armed: false,
    mode: "TRAIL_RETRACE",
    trailPct: MANUAL_PROTECT_DEFAULT_TRAIL_PCT,
    triggerPrice: null,
    highestPrice: null,
    lowestPrice: null,
    slot: null,
    side: null,
    symbol: null,
    note: "",
    updatedAt: 0,
  };
}

function defaultState() {
  return {
    running: true,
    cashBalance: START_BAL,
    availableCapital: START_BAL,
    lockedCapital: 0,
    equity: START_BAL,
    totalCapital: START_BAL,
    position: null,
    positions: {
      structure: null,
      scalp: null,
    },
    trades: [],
    decisions: [],
    volatility: 0.003,
    lastPrice: 0,
    lastPriceBySymbol: {},
    lastTradeTime: 0,
    lastProcessedTickAtBySymbol: {},
    lastProcessedPriceBySymbol: {},
    protection: defaultProtectionState(),
    realized: {
      wins: 0,
      losses: 0,
      net: 0,
      fees: 0,
    },
    limits: {
      tradesToday: 0,
      lossesToday: 0,
      lastResetDate: getDayKey(),
    },
    executionStats: {
      ticks: 0,
      decisions: 0,
      trades: 0,
    },
    _locked: false,
  };
}

const STATES = new Map();
const PRICE_HISTORY = new Map();

function load(tenantId) {
  if (STATES.has(tenantId)) {
    const state = STATES.get(tenantId);
    ensureStateShape(state);
    return state;
  }

  const state = defaultState();
  STATES.set(tenantId, state);
  return state;
}

/* =========================================================
HELPERS
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureStateShape(state) {
  if (!state || typeof state !== "object") return;

  if (!Array.isArray(state.trades)) state.trades = [];
  if (!Array.isArray(state.decisions)) state.decisions = [];

  if (!state.positions || typeof state.positions !== "object") {
    state.positions = {
      structure: null,
      scalp: null,
    };
  }

  if (!state.lastPriceBySymbol || typeof state.lastPriceBySymbol !== "object") {
    state.lastPriceBySymbol = {};
  }

  if (
    !state.lastProcessedTickAtBySymbol ||
    typeof state.lastProcessedTickAtBySymbol !== "object"
  ) {
    state.lastProcessedTickAtBySymbol = {};
  }

  if (
    !state.lastProcessedPriceBySymbol ||
    typeof state.lastProcessedPriceBySymbol !== "object"
  ) {
    state.lastProcessedPriceBySymbol = {};
  }

  if (!state.limits || typeof state.limits !== "object") {
    state.limits = {
      tradesToday: 0,
      lossesToday: 0,
      lastResetDate: getDayKey(),
    };
  }

  if (!state.executionStats || typeof state.executionStats !== "object") {
    state.executionStats = {
      ticks: 0,
      decisions: 0,
      trades: 0,
    };
  }

  if (!state.protection || typeof state.protection !== "object") {
    state.protection = defaultProtectionState();
  }

  if (!state.realized || typeof state.realized !== "object") {
    state.realized = {
      wins: 0,
      losses: 0,
      net: 0,
      fees: 0,
    };
  }

  if (!Number.isFinite(Number(state.cashBalance))) state.cashBalance = START_BAL;
  if (!Number.isFinite(Number(state.availableCapital))) state.availableCapital = state.cashBalance;
  if (!Number.isFinite(Number(state.lockedCapital))) state.lockedCapital = 0;
  if (!Number.isFinite(Number(state.equity))) state.equity = state.cashBalance;
  if (!Number.isFinite(Number(state.totalCapital))) state.totalCapital = state.cashBalance;

  if (!state.position && state.positions) {
    state.position =
      state.positions.scalp ||
      state.positions.structure ||
      null;
  }

  if (state.position && !state.positions.scalp && !state.positions.structure) {
    const slot = state.position.slot || "scalp";
    if (slot === "structure") state.positions.structure = state.position;
    else state.positions.scalp = state.position;
  }

  state.position = state.position || null;
}

function historyKey(tenantId, symbol) {
  return `${tenantId || "__default__"}::${symbol || "__unknown__"}`;
}

function recordPrice(tenantId, symbol, price) {
  const key = historyKey(tenantId, symbol);

  if (!PRICE_HISTORY.has(key)) {
    PRICE_HISTORY.set(key, []);
  }

  const arr = PRICE_HISTORY.get(key);
  arr.push(price);

  if (arr.length > 180) {
    arr.shift();
  }

  return arr;
}

function resetDailyLimitsIfNeeded(state, ts = Date.now()) {
  const dayKey = getDayKey(ts);

  if (state.limits.lastResetDate !== dayKey) {
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
    state.limits.lastResetDate = dayKey;
  }
}

function recordDecision(state, plan, ts = Date.now()) {
  state.decisions.push({
    ...plan,
    time: ts,
  });

  if (state.decisions.length > 200) {
    state.decisions.shift();
  }
}

function isDuplicateTick(state, symbol, price, ts) {
  const lastTs = safeNum(state.lastProcessedTickAtBySymbol?.[symbol], 0);
  const lastPrice = safeNum(state.lastProcessedPriceBySymbol?.[symbol], NaN);

  if (!lastTs) return false;
  if (!Number.isFinite(lastPrice)) return false;

  return lastPrice === price && Math.abs(ts - lastTs) <= DUPLICATE_TICK_WINDOW_MS;
}

function rememberProcessedTick(state, symbol, price, ts) {
  state.lastProcessedTickAtBySymbol[symbol] = ts;
  state.lastProcessedPriceBySymbol[symbol] = price;
}

function syncPrimaryPosition(state) {
  state.position =
    state.positions?.scalp ||
    state.positions?.structure ||
    null;
}

function syncPositionSlotsFromPrimary(state) {
  if (!state.position) {
    state.positions.scalp = null;
    state.positions.structure = null;
    return;
  }

  const slot = state.position.slot || "scalp";

  if (slot === "structure") {
    state.positions.structure = state.position;
    state.positions.scalp = null;
  } else {
    state.positions.scalp = state.position;
    state.positions.structure = null;
  }
}

function updateCapitalView(state, currentPriceBySymbol = null) {
  ensureStateShape(state);

  const pos = state.position;
  if (!pos) {
    state.lockedCapital = 0;
    state.availableCapital = Math.max(0, safeNum(state.cashBalance));
    state.equity = safeNum(state.cashBalance);
    state.totalCapital = safeNum(state.cashBalance);
    return;
  }

  const markPrice =
    currentPriceBySymbol && typeof currentPriceBySymbol === "object"
      ? safeNum(
          currentPriceBySymbol[pos.symbol],
          safeNum(state.lastPriceBySymbol?.[pos.symbol], pos.entry)
        )
      : safeNum(state.lastPriceBySymbol?.[pos.symbol], pos.entry);

  const capitalUsed = safeNum(
    pos.capitalUsed,
    safeNum(pos.qty) * safeNum(pos.entry)
  );

  const unrealized =
    pos.side === "LONG"
      ? (markPrice - pos.entry) * pos.qty
      : (pos.entry - markPrice) * pos.qty;

  state.lockedCapital = Math.max(0, capitalUsed);
  state.availableCapital = Math.max(
    0,
    safeNum(state.cashBalance) - state.lockedCapital + Math.max(0, unrealized)
  );
  state.equity = safeNum(state.cashBalance) + unrealized;
  state.totalCapital = Math.max(
    safeNum(state.cashBalance),
    safeNum(state.cashBalance) + Math.max(0, unrealized)
  );
}

function resetProtection(state, note = "") {
  state.protection = {
    ...defaultProtectionState(),
    note,
    updatedAt: Date.now(),
  };
}

function snapshot(tenantId) {
  const s = load(tenantId);
  ensureStateShape(s);
  syncPrimaryPosition(s);

  return {
    running: !!s.running,
    cashBalance: safeNum(s.cashBalance),
    availableCapital: safeNum(s.availableCapital, safeNum(s.cashBalance)),
    lockedCapital: safeNum(s.lockedCapital),
    equity: safeNum(s.equity, safeNum(s.cashBalance)),
    totalCapital: safeNum(s.totalCapital, safeNum(s.cashBalance)),
    position: s.position ? { ...s.position } : null,
    positions: {
      structure: s.positions?.structure ? { ...s.positions.structure } : null,
      scalp: s.positions?.scalp ? { ...s.positions.scalp } : null,
    },
    trades: Array.isArray(s.trades) ? s.trades.slice(-500) : [],
    decisions: Array.isArray(s.decisions) ? s.decisions.slice(-200) : [],
    volatility: safeNum(s.volatility, 0.003),
    lastPrice: safeNum(s.lastPrice),
    lastPriceBySymbol: { ...(s.lastPriceBySymbol || {}) },
    lastTradeTime: safeNum(s.lastTradeTime),
    protection: {
      ...defaultProtectionState(),
      ...(s.protection || {}),
    },
    realized: {
      wins: safeNum(s.realized?.wins),
      losses: safeNum(s.realized?.losses),
      net: safeNum(s.realized?.net),
      fees: safeNum(s.realized?.fees),
    },
    limits: {
      tradesToday: safeNum(s.limits?.tradesToday),
      lossesToday: safeNum(s.limits?.lossesToday),
      lastResetDate: s.limits?.lastResetDate || getDayKey(),
    },
    executionStats: {
      ticks: safeNum(s.executionStats?.ticks),
      decisions: safeNum(s.executionStats?.decisions),
      trades: safeNum(s.executionStats?.trades),
    },
  };
}

function getDecisions(tenantId) {
  return load(tenantId).decisions || [];
}

function getState(tenantId) {
  const state = load(tenantId);
  ensureStateShape(state);
  return state;
}

/* =========================================================
POSITION MANAGEMENT
========================================================= */

function initPositionRuntime(pos) {
  if (!Number.isFinite(pos.bestPnl)) pos.bestPnl = 0;
  if (!Number.isFinite(pos.lockedProfitFloor)) pos.lockedProfitFloor = NaN;
  if (!Number.isFinite(pos.warningPrice)) pos.warningPrice = NaN;
  if (typeof pos.targetReached !== "boolean") pos.targetReached = false;
  if (typeof pos.runnerConfirmed !== "boolean") pos.runnerConfirmed = false;
  if (!Number.isFinite(pos.warningTouches)) pos.warningTouches = 0;
  if (!Number.isFinite(pos.takeProfitPct)) pos.takeProfitPct = TAKE_PROFIT_PCT;
  if (!Number.isFinite(pos.maxDuration)) pos.maxDuration = computeDuration(0.5);
}

function computeDuration(confidence) {
  const ratio = clamp(safeNum(confidence, 0), 0, 1);

  return Math.floor(
    MIN_TRADE_DURATION +
      ratio * (MAX_TRADE_DURATION - MIN_TRADE_DURATION)
  );
}

function updateBestPnl(pos, pnl) {
  if (pnl > pos.bestPnl) {
    pos.bestPnl = pnl;
  }
}

function getPnLPct(pos, price) {
  return pos.side === "LONG"
    ? (price - pos.entry) / pos.entry
    : (pos.entry - price) / pos.entry;
}

function detectTrendRun(prices, side, minBars = 3) {
  if (prices.length < minBars + 1) return false;

  let run = 0;

  for (let i = prices.length - 1; i > 0; i--) {
    const move = prices[i] - prices[i - 1];

    if (side === "LONG" && move > 0) run++;
    else if (side === "SHORT" && move < 0) run++;
    else break;

    if (run >= minBars) return true;
  }

  return false;
}

function detectMomentumWeakening(prices) {
  if (prices.length < 5) return false;

  const m1 = prices[prices.length - 1] - prices[prices.length - 2];
  const m2 = prices[prices.length - 2] - prices[prices.length - 3];
  const m3 = prices[prices.length - 3] - prices[prices.length - 4];

  return Math.abs(m1) < Math.abs(m2) && Math.abs(m2) < Math.abs(m3);
}

function detectHardMomentumBreak(prices, side) {
  if (prices.length < 4) return false;

  const m1 = prices[prices.length - 1] - prices[prices.length - 2];
  const m2 = prices[prices.length - 2] - prices[prices.length - 3];

  if (side === "LONG") return m1 < 0 && m2 < 0;
  if (side === "SHORT") return m1 > 0 && m2 > 0;

  return false;
}

function detectWeakReversal(prices, side) {
  if (prices.length < 4) return false;

  const m1 = prices[prices.length - 1] - prices[prices.length - 2];
  const m2 = prices[prices.length - 2] - prices[prices.length - 3];

  if (side === "LONG") return m1 < 0 && m2 <= 0;
  if (side === "SHORT") return m1 > 0 && m2 >= 0;

  return false;
}

function computeWarningPrice(pos) {
  if (pos.bestPnl > 0) {
    if (pos.side === "LONG") {
      return pos.entry * (1 + Math.max(0, pos.bestPnl - WARNING_PULLBACK_PCT));
    }
    return pos.entry * (1 - Math.max(0, pos.bestPnl - WARNING_PULLBACK_PCT));
  }

  if (pos.side === "LONG") return pos.entry * (1 - WARNING_PULLBACK_PCT);
  return pos.entry * (1 + WARNING_PULLBACK_PCT);
}

function isWarningTouched(pos, price) {
  if (!Number.isFinite(pos.warningPrice)) return false;
  if (pos.side === "LONG") return price <= pos.warningPrice;
  return price >= pos.warningPrice;
}

function protectProfitFloor(pos, strongTrend) {
  if (pos.bestPnl < BREAK_EVEN_TRIGGER) return;

  const breakEvenFloor =
    pos.side === "LONG"
      ? pos.entry * 1.00015
      : pos.entry * 0.99985;

  if (pos.side === "LONG") {
    pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
      ? Math.max(pos.lockedProfitFloor, breakEvenFloor)
      : breakEvenFloor;
  } else {
    pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
      ? Math.min(pos.lockedProfitFloor, breakEvenFloor)
      : breakEvenFloor;
  }

  if (pos.bestPnl >= MIN_PROFIT_TO_TRAIL) {
    const lockPct = strongTrend ? 0.25 : LOCKED_PROFIT_PCT;
    const protectedPnl = pos.bestPnl * lockPct;

    const floorFromPnl =
      pos.side === "LONG"
        ? pos.entry * (1 + protectedPnl)
        : pos.entry * (1 - protectedPnl);

    if (pos.side === "LONG") {
      pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
        ? Math.max(pos.lockedProfitFloor, floorFromPnl)
        : floorFromPnl;
    } else {
      pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
        ? Math.min(pos.lockedProfitFloor, floorFromPnl)
        : floorFromPnl;
    }
  }
}

function shouldExitByLockedFloor(pos, price) {
  if (!Number.isFinite(pos.lockedProfitFloor)) return false;
  if (pos.side === "LONG") return price <= pos.lockedProfitFloor;
  return price >= pos.lockedProfitFloor;
}

function reachedTarget(pos, pnl, strongTrend) {
  const tp = Number.isFinite(pos.takeProfitPct)
    ? pos.takeProfitPct
    : TAKE_PROFIT_PCT;

  if (pnl < tp) return false;

  if (strongTrend && pnl >= RUNNER_MIN_PROFIT) {
    pos.targetReached = true;
    pos.runnerConfirmed = true;
    return false;
  }

  return true;
}

function shouldExitRunnerGiveback(pos, pnl) {
  if (!pos.runnerConfirmed) return false;
  if (pos.bestPnl < RUNNER_MIN_PROFIT) return false;

  const giveback = pos.bestPnl - pnl;
  return giveback >= pos.bestPnl * RUNNER_GIVEBACK_PCT;
}

function shouldExitByManualStopLoss(pos, price) {
  if (!Number.isFinite(Number(pos.stopLoss))) return false;

  if (pos.side === "LONG") return price <= Number(pos.stopLoss);
  if (pos.side === "SHORT") return price >= Number(pos.stopLoss);

  return false;
}

function shouldExitByManualTakeProfit(pos, price) {
  if (!Number.isFinite(Number(pos.takeProfit))) return false;

  if (pos.side === "LONG") return price >= Number(pos.takeProfit);
  if (pos.side === "SHORT") return price <= Number(pos.takeProfit);

  return false;
}

function updateManualProtection(state, pos, price) {
  const protection = state.protection;
  if (!protection?.armed) return false;
  if (!pos) return false;
  if (protection.symbol && protection.symbol !== pos.symbol) return false;
  if (protection.slot && protection.slot !== (pos.slot || "scalp")) return false;

  const trailPct = clamp(
    safeNum(protection.trailPct, MANUAL_PROTECT_DEFAULT_TRAIL_PCT),
    0.0001,
    0.25
  );

  if (pos.side === "LONG") {
    const highest = Math.max(
      safeNum(protection.highestPrice, pos.entry),
      safeNum(price, pos.entry)
    );

    protection.highestPrice = highest;
    protection.lowestPrice = null;
    protection.triggerPrice = highest * (1 - trailPct);
    protection.side = pos.side;
    protection.slot = pos.slot || "scalp";
    protection.symbol = pos.symbol;
    protection.updatedAt = Date.now();

    return price <= protection.triggerPrice;
  }

  if (pos.side === "SHORT") {
    const lowSeed = Number.isFinite(Number(protection.lowestPrice))
      ? Number(protection.lowestPrice)
      : pos.entry;

    const lowest = Math.min(lowSeed, safeNum(price, pos.entry));

    protection.lowestPrice = lowest;
    protection.highestPrice = null;
    protection.triggerPrice = lowest * (1 + trailPct);
    protection.side = pos.side;
    protection.slot = pos.slot || "scalp";
    protection.symbol = pos.symbol;
    protection.updatedAt = Date.now();

    return price >= protection.triggerPrice;
  }

  return false;
}

function closeTrade({ tenantId, state, symbol, price, ts, reason = "CLOSE" }) {
  const closed = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action: "CLOSE",
    price,
    state,
    slot: state.position?.slot || "scalp",
    ts,
  });

  const result = closed?.result;
  if (!result) return false;

  const pnl = safeNum(result.pnl, 0);
  const fees = safeNum(result.fees, 0);

  if (pnl >= 0) state.realized.wins += 1;
  else {
    state.realized.losses += 1;
    state.limits.lossesToday += 1;
  }

  state.realized.net = safeNum(state.realized.net, 0) + pnl;
  state.realized.fees = safeNum(state.realized.fees, 0) + fees;

  state.lastTradeTime = ts;

  state.position = null;
  state.positions.scalp = null;
  state.positions.structure = null;

  resetProtection(state, `Closed: ${reason}`);

  recordDecision(
    state,
    {
      action: "CLOSE",
      mode: "MANUAL_OR_ENGINE",
      symbol,
      price,
      reason,
    },
    ts
  );

  updateCapitalView(state, { [symbol]: price });
  return true;
}

function handleOpenPosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  prices,
}) {
  const pos = state.position;

  if (!pos) return false;
  if (pos.symbol !== symbol) return false;

  const elapsed = ts - pos.time;
  const pnl = getPnLPct(pos, price);

  const strongTrend = detectTrendRun(prices, pos.side, 3);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices, pos.side);
  const weakReversal = detectWeakReversal(prices, pos.side);

  initPositionRuntime(pos);
  updateBestPnl(pos, pnl);

  pos.warningPrice = computeWarningPrice(pos);
  protectProfitFloor(pos, strongTrend);

  if (shouldExitByManualStopLoss(pos, price)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "POSITION_STOP_LOSS_HIT",
    });
  }

  if (shouldExitByManualTakeProfit(pos, price)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "POSITION_TAKE_PROFIT_HIT",
    });
  }

  if (updateManualProtection(state, pos, price)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "MANUAL_PROTECT_TRAIL_HIT",
    });
  }

  if (pnl <= HARD_STOP_LOSS) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "HARD_STOP",
    });
  }

  if (elapsed < MIN_HOLD_TIME) return false;

  if (shouldExitByLockedFloor(pos, price)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "LOCKED_FLOOR",
    });
  }

  if (reachedTarget(pos, pnl, strongTrend)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "TAKE_PROFIT",
    });
  }

  if (shouldExitRunnerGiveback(pos, pnl)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "RUNNER_GIVEBACK",
    });
  }

  if (strongTrend && pnl > 0) {
    pos.maxDuration = Math.min(
      pos.maxDuration + 20000,
      computeDuration(1) + MAX_EXTENSION_DURATION
    );
    return false;
  }

  if (
    pnl > MIN_PROFIT_TO_TRAIL &&
    !strongTrend &&
    (momentumWeak || hardBreak || weakReversal)
  ) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "MOMENTUM_WEAKENING",
    });
  }

  if (
    pnl > 0 &&
    isWarningTouched(pos, price) &&
    !strongTrend &&
    (hardBreak || weakReversal)
  ) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "WARNING_EXIT",
    });
  }

  if (elapsed >= pos.maxDuration) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      reason: "TIME_EXIT",
    });
  }

  return false;
}

/* =========================================================
OPEN TRADE
========================================================= */

function openTrade({
  tenantId,
  state,
  symbol,
  action,
  plan,
  price,
  ts,
}) {
  if (state.position) {
    return false;
  }

  const exec = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action,
    price,
    riskPct: Number(plan.riskPct || 0.01),
    confidence: Number(plan.confidence || 0.5),
    stopLoss: Number.isFinite(Number(plan.stopLoss)) ? Number(plan.stopLoss) : undefined,
    takeProfit: Number.isFinite(Number(plan.takeProfit)) ? Number(plan.takeProfit) : undefined,
    state,
    slot: "scalp",
    ts,
  });

  if (exec?.result) {
    state.executionStats.trades++;
    state.limits.tradesToday++;
    state.lastTradeTime = ts;

    const pos =
      state.position ||
      state.positions?.scalp ||
      state.positions?.structure ||
      null;

    if (pos) {
      state.position = pos;
      pos.slot = pos.slot || "scalp";
      pos.mode = "SINGLE";
      pos.bestPnl = 0;
      pos.targetReached = false;
      pos.runnerConfirmed = false;
      pos.lockedProfitFloor = NaN;
      pos.warningPrice = NaN;
      pos.warningTouches = 0;
      pos.takeProfitPct = TAKE_PROFIT_PCT;
      pos.maxDuration = computeDuration(plan.confidence);

      if (Number.isFinite(Number(plan.stopLoss))) {
        pos.stopLoss = Number(plan.stopLoss);
      }

      if (Number.isFinite(Number(plan.takeProfit))) {
        pos.takeProfit = Number(plan.takeProfit);
      }

      syncPositionSlotsFromPrimary(state);
    }

    resetProtection(state, "Idle");
    updateCapitalView(state, { [symbol]: price });
    return true;
  }

  return false;
}

/* =========================================================
MANUAL ACTIONS
========================================================= */

function manualClosePosition(tenantId, payload = {}) {
  const state = load(tenantId);
  ensureStateShape(state);

  const pos = state.position;
  if (!pos) {
    return {
      ok: false,
      error: "NO_OPEN_POSITION",
      snapshot: snapshot(tenantId),
    };
  }

  const symbol = payload.symbol || pos.symbol;
  const price = safeNum(
    payload.price,
    safeNum(state.lastPriceBySymbol?.[symbol], pos.entry)
  );
  const ts = safeNum(payload.ts, Date.now());
  const reason = payload.reason || "MANUAL_CLOSE_NOW";

  const ok = closeTrade({
    tenantId,
    state,
    symbol,
    price,
    ts,
    reason,
  });

  return {
    ok,
    snapshot: snapshot(tenantId),
  };
}

function armProfitProtection(tenantId, payload = {}) {
  const state = load(tenantId);
  ensureStateShape(state);

  const pos = state.position;
  if (!pos) {
    return {
      ok: false,
      error: "NO_OPEN_POSITION",
      snapshot: snapshot(tenantId),
    };
  }

  const symbol = payload.symbol || pos.symbol;
  const slot = payload.slot || pos.slot || "scalp";
  const side = pos.side || null;
  const currentPrice = safeNum(
    state.lastPriceBySymbol?.[symbol],
    pos.entry
  );
  const trailPct = clamp(
    safeNum(payload.trailPct, MANUAL_PROTECT_DEFAULT_TRAIL_PCT),
    0.0001,
    0.25
  );

  const next = {
    armed: true,
    mode: payload.mode || "TRAIL_RETRACE",
    trailPct,
    triggerPrice: null,
    highestPrice: side === "LONG" ? currentPrice : null,
    lowestPrice: side === "SHORT" ? currentPrice : null,
    slot,
    side,
    symbol,
    note: "Profit protection armed",
    updatedAt: Date.now(),
  };

  if (side === "LONG") {
    next.triggerPrice = currentPrice * (1 - trailPct);
  } else if (side === "SHORT") {
    next.triggerPrice = currentPrice * (1 + trailPct);
  }

  state.protection = next;

  recordDecision(
    state,
    {
      action: "PROTECT_PROFIT_ARM",
      mode: "MANUAL",
      symbol,
      price: currentPrice,
      slot,
      trailPct,
    },
    Date.now()
  );

  return {
    ok: true,
    protection: { ...state.protection },
    snapshot: snapshot(tenantId),
  };
}

function disarmProfitProtection(tenantId, payload = {}) {
  const state = load(tenantId);
  ensureStateShape(state);

  const symbol =
    payload.symbol ||
    state.position?.symbol ||
    "BTCUSDT";

  recordDecision(
    state,
    {
      action: "PROTECT_PROFIT_DISARM",
      mode: "MANUAL",
      symbol,
      price: safeNum(state.lastPriceBySymbol?.[symbol], 0),
      slot: payload.slot || state.position?.slot || "scalp",
    },
    Date.now()
  );

  resetProtection(state, "Profit protection disarmed");

  return {
    ok: true,
    protection: { ...state.protection },
    snapshot: snapshot(tenantId),
  };
}

/* =========================================================
TICK ENGINE
========================================================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  ensureStateShape(state);

  if (!state.running) return;
  if (!symbol) return;
  if (!Number.isFinite(price) || price <= 0) return;
  if (state._locked) return;

  if (isDuplicateTick(state, symbol, price, ts)) {
    return;
  }

  state._locked = true;

  try {
    resetDailyLimitsIfNeeded(state, ts);

    const prev = safeNum(state.lastPriceBySymbol?.[symbol], NaN);
    state.lastPrice = price;
    state.lastPriceBySymbol[symbol] = price;
    rememberProcessedTick(state, symbol, price, ts);

    const prices = recordPrice(tenantId, symbol, price);

    if (Number.isFinite(prev) && prev > 0) {
      const change = Math.abs(price - prev) / prev;
      state.volatility = Math.max(
        0.0005,
        state.volatility * 0.9 + change * 0.1
      );
    }

    state.executionStats.ticks++;

    if (state.position && state.position.symbol === symbol) {
      state.executionStats.decisions++;

      recordDecision(
        state,
        {
          action: "MANAGE",
          mode: "SINGLE",
          symbol,
          price,
          volatility: state.volatility,
        },
        ts
      );

      handleOpenPosition({
        tenantId,
        state,
        symbol,
        price,
        ts,
        prices,
      });
    }

    updateCapitalView(state, { [symbol]: price });

    let cooldown = COOLDOWN_AFTER_TRADE;
    if (state.limits.lossesToday >= LOSS_STREAK_SLOWDOWN) {
      cooldown += EXTRA_COOLDOWN_ON_LOSS_STREAK;
    }

    if (
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    ) {
      updateCapitalView(state, { [symbol]: price });
      return;
    }

    if (!state.position && ts - safeNum(state.lastTradeTime, 0) >= cooldown) {
      const plan =
        makeDecision({
          tenantId,
          symbol,
          last: price,
          paper: state,
        }) || { action: "WAIT" };

      state.executionStats.decisions++;

      recordDecision(
        state,
        {
          ...plan,
          mode: "SINGLE",
          symbol,
          price,
          volatility: state.volatility,
        },
        ts
      );

      if (plan.action === "BUY" || plan.action === "SELL") {
        openTrade({
          tenantId,
          state,
          symbol,
          action: plan.action,
          plan,
          price,
          ts,
        });
      }
    } else if (state.position) {
      const plan =
        makeDecision({
          tenantId,
          symbol,
          last: price,
          paper: state,
        }) || { action: "WAIT" };

      state.executionStats.decisions++;

      recordDecision(
        state,
        {
          ...plan,
          mode: "SINGLE",
          symbol,
          price,
          volatility: state.volatility,
        },
        ts
      );

      if (plan.action === "CLOSE") {
        closeTrade({
          tenantId,
          state,
          symbol,
          price,
          ts,
          reason: "BRAIN_CLOSE",
        });
      }
    }

    updateCapitalView(state, { [symbol]: price });
  } finally {
    state._locked = false;
  }
}

/* =========================================================
MANUAL RESET
========================================================= */

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
  PRICE_HISTORY.delete(historyKey(tenantId, "BTCUSDT"));
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  tick,
  snapshot,
  getDecisions,
  getState,
  hardReset,
  manualClosePosition,
  armProfitProtection,
  disarmProfitProtection,
};
