// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v47 (Confirmed Entry + Smart Runner TP + Symbol Safe)
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

/* HOLDING LOGIC */

const MIN_HOLD_TIME =
  Number(process.env.TRADE_MIN_HOLD_MS || 15000);

const MIN_TRADE_DURATION =
  Number(process.env.TRADE_MIN_DURATION_MS || 2 * 60 * 1000);

const MAX_TRADE_DURATION =
  Number(process.env.TRADE_MAX_DURATION_MS || 20 * 60 * 1000);

const MAX_EXTENSION_DURATION =
  Number(process.env.TRADE_MAX_EXTENSION_MS || 15 * 60 * 1000);

/* RISK */

const HARD_STOP_LOSS =
  Number(process.env.TRADE_HARD_STOP_LOSS || -0.0045);

const MIN_PROFIT_TO_TRAIL =
  Number(process.env.TRADE_MIN_PROFIT_TO_TRAIL || 0.0025);

/* SMART TAKE PROFIT */

const SCALP_TAKE_PROFIT =
  Number(process.env.TRADE_SCALP_TAKE_PROFIT || 0.0035);

const SCALP_BREAK_EVEN_TRIGGER =
  Number(process.env.TRADE_SCALP_BREAK_EVEN_TRIGGER || 0.0018);

const SCALP_LOCKED_PROFIT_PCT =
  Number(process.env.TRADE_SCALP_LOCKED_PROFIT_PCT || 0.40);

const RUNNER_MIN_PROFIT =
  Number(process.env.TRADE_RUNNER_MIN_PROFIT || 0.0040);

const RUNNER_GIVEBACK_PCT =
  Number(process.env.TRADE_RUNNER_GIVEBACK_PCT || 0.35);

/* DUAL MODE */

const STRUCTURE_LOOKBACK =
  Number(process.env.TRADE_STRUCTURE_LOOKBACK || 30);

const STRUCTURE_ENTRY_BUFFER =
  Number(process.env.TRADE_STRUCTURE_ENTRY_BUFFER || 0.0015);

const STRUCTURE_MIN_SWING =
  Number(process.env.TRADE_STRUCTURE_MIN_SWING || 0.0035);

const STRONG_TREND_BARS =
  Number(process.env.TRADE_STRONG_TREND_BARS || 5);

const LOSS_STREAK_SLOWDOWN =
  Number(process.env.TRADE_LOSS_STREAK_SLOWDOWN || 3);

const EXTRA_COOLDOWN_ON_LOSS_STREAK =
  Number(process.env.TRADE_EXTRA_COOLDOWN_ON_LOSS_STREAK || 90000);

/* SMART STRUCTURE EXIT */

const STRUCTURE_TARGET_BUFFER =
  Number(process.env.TRADE_STRUCTURE_TARGET_BUFFER || 0.0006);

const STRUCTURE_PROFIT_LOCK =
  Number(process.env.TRADE_STRUCTURE_PROFIT_LOCK || 0.45);

const STRUCTURE_MIN_LOCK_PNL =
  Number(process.env.TRADE_STRUCTURE_MIN_LOCK_PNL || 0.0015);

const STRUCTURE_BREAK_EVEN_PNL =
  Number(process.env.TRADE_STRUCTURE_BREAK_EVEN_PNL || 0.0020);

/* SMART EXIT / WEAKNESS CONTROL */

const WARNING_PULLBACK_PCT =
  Number(process.env.TRADE_WARNING_PULLBACK_PCT || 0.0012);

const STRUCTURE_WARNING_PULLBACK_PCT =
  Number(process.env.TRADE_STRUCTURE_WARNING_PULLBACK_PCT || 0.0018);

const RUNNER_CONFIRM_BARS =
  Number(process.env.TRADE_RUNNER_CONFIRM_BARS || 2);

const ENTRY_CHASE_BLOCK_PCT =
  Number(process.env.TRADE_ENTRY_CHASE_BLOCK_PCT || 0.0022);

const ENTRY_EXTENSION_LOOKBACK =
  Number(process.env.TRADE_ENTRY_EXTENSION_LOOKBACK || 8);

const ENTRY_EXTENSION_BLOCK_PCT =
  Number(process.env.TRADE_ENTRY_EXTENSION_BLOCK_PCT || 0.0035);

/* ENTRY CONFIRMATION */

const ENTRY_CONFIRM_BARS =
  Number(process.env.TRADE_ENTRY_CONFIRM_BARS || 2);

const SUPPORT_REJECTION_MIN_BOUNCE =
  Number(process.env.TRADE_SUPPORT_REJECTION_MIN_BOUNCE || 0.0008);

const RESISTANCE_REJECTION_MIN_DROP =
  Number(process.env.TRADE_RESISTANCE_REJECTION_MIN_DROP || 0.0008);

/* =========================================================
STATE
========================================================= */

function defaultState() {
  return {
    running: true,
    cashBalance: START_BAL,
    availableCapital: START_BAL,
    lockedCapital: 0,
    position: null,
    trades: [],
    decisions: [],
    volatility: 0.003,
    lastPriceBySymbol: {},
    lastTradeTime: 0,
    lastMode: "SCALP",
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

function load(tenantId) {
  if (STATES.has(tenantId)) {
    return STATES.get(tenantId);
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

function resetDailyLimitsIfNeeded(state, ts = Date.now()) {
  const dayKey = getDayKey(ts);

  if (state?.limits?.lastResetDate !== dayKey) {
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

function snapshot(tenantId) {
  const s = load(tenantId);

  return {
    running: !!s.running,
    cashBalance: safeNum(s.cashBalance),
    availableCapital: safeNum(s.availableCapital, safeNum(s.cashBalance)),
    lockedCapital: safeNum(s.lockedCapital),
    position: s.position ? { ...s.position } : null,
    trades: Array.isArray(s.trades) ? s.trades.slice(-500) : [],
    decisions: Array.isArray(s.decisions) ? s.decisions.slice(-200) : [],
    volatility: safeNum(s.volatility, 0.003),
    lastPriceBySymbol: { ...(s.lastPriceBySymbol || {}) },
    lastTradeTime: safeNum(s.lastTradeTime),
    lastMode: s.lastMode || "SCALP",
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

function updateCapitalView(state, currentPrice = null) {
  const pos = state.position;

  if (!pos) {
    state.lockedCapital = 0;
    state.availableCapital = Math.max(0, safeNum(state.cashBalance));
    return;
  }

  const markPrice = safeNum(currentPrice, pos.entry);
  const capitalUsed = safeNum(pos.capitalUsed, safeNum(pos.qty) * safeNum(pos.entry));
  const unrealized =
    pos.side === "LONG"
      ? (markPrice - pos.entry) * pos.qty
      : (pos.entry - markPrice) * pos.qty;

  state.lockedCapital = Math.max(0, capitalUsed);
  state.availableCapital = Math.max(
    0,
    safeNum(state.cashBalance) - state.lockedCapital + Math.max(0, unrealized)
  );
}

/* =========================================================
PRICE MEMORY (SYMBOL SAFE)
========================================================= */

const PRICE_HISTORY = new Map();

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

function getPrices(tenantId, symbol) {
  return PRICE_HISTORY.get(historyKey(tenantId, symbol)) || [];
}

/* =========================================================
TREND / STRUCTURE DETECTION
========================================================= */

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

function getStructureZones(prices) {
  if (prices.length < STRUCTURE_LOOKBACK) return null;

  const slice = prices.slice(-STRUCTURE_LOOKBACK);
  const resistance = Math.max(...slice);
  const support = Math.min(...slice);
  const range = resistance - support;

  if (range <= 0 || support <= 0) return null;

  const swingPct = range / support;

  return {
    resistance,
    support,
    range,
    swingPct,
    mid: (resistance + support) / 2,
  };
}

function detectMarketBias(prices) {
  if (prices.length < STRONG_TREND_BARS + 2) return "neutral";

  let up = 0;
  let down = 0;

  const start = Math.max(1, prices.length - (STRONG_TREND_BARS + 1));

  for (let i = start; i < prices.length; i++) {
    const move = prices[i] - prices[i - 1];
    if (move > 0) up++;
    else if (move < 0) down++;
  }

  if (up >= STRONG_TREND_BARS) return "up";
  if (down >= STRONG_TREND_BARS) return "down";
  if (up > down) return "up_soft";
  if (down > up) return "down_soft";

  return "neutral";
}

function chooseTradeMode(prices) {
  const zones = getStructureZones(prices);

  if (!zones) {
    return { mode: "SCALP", zones: null, bias: "neutral" };
  }

  const bias = detectMarketBias(prices);

  if (
    zones.swingPct >= STRUCTURE_MIN_SWING &&
    (
      bias === "up" ||
      bias === "down" ||
      bias === "up_soft" ||
      bias === "down_soft"
    )
  ) {
    return { mode: "STRUCTURE", zones, bias };
  }

  return { mode: "SCALP", zones, bias };
}

/* =========================================================
ENTRY CONFIRMATION
========================================================= */

function isSupportBounceConfirmed(prices, support) {
  if (!Array.isArray(prices) || prices.length < Math.max(4, ENTRY_CONFIRM_BARS + 2)) {
    return false;
  }

  const p0 = prices[prices.length - 1];
  const p1 = prices[prices.length - 2];
  const p2 = prices[prices.length - 3];

  const touchedSupport =
    Math.abs(p2 - support) / support <= STRUCTURE_ENTRY_BUFFER ||
    Math.abs(p1 - support) / support <= STRUCTURE_ENTRY_BUFFER;

  const bounce1 = (p1 - p2) / Math.max(p2, 1e-12);
  const bounce2 = (p0 - p1) / Math.max(p1, 1e-12);

  return touchedSupport &&
    bounce1 > 0 &&
    bounce2 > 0 &&
    ((p0 - Math.min(p1, p2)) / Math.max(Math.min(p1, p2), 1e-12)) >= SUPPORT_REJECTION_MIN_BOUNCE;
}

function isResistanceRejectionConfirmed(prices, resistance) {
  if (!Array.isArray(prices) || prices.length < Math.max(4, ENTRY_CONFIRM_BARS + 2)) {
    return false;
  }

  const p0 = prices[prices.length - 1];
  const p1 = prices[prices.length - 2];
  const p2 = prices[prices.length - 3];

  const touchedResistance =
    Math.abs(resistance - p2) / resistance <= STRUCTURE_ENTRY_BUFFER ||
    Math.abs(resistance - p1) / resistance <= STRUCTURE_ENTRY_BUFFER;

  const drop1 = (p1 - p2) / Math.max(p2, 1e-12);
  const drop2 = (p0 - p1) / Math.max(p1, 1e-12);

  return touchedResistance &&
    drop1 < 0 &&
    drop2 < 0 &&
    ((Math.max(p1, p2) - p0) / Math.max(Math.max(p1, p2), 1e-12)) >= RESISTANCE_REJECTION_MIN_DROP;
}

function buildStructurePlan({ price, zones, bias, symbol, prices }) {
  if (!zones) {
    return { action: "WAIT", mode: "STRUCTURE", reason: "NO_ZONES" };
  }

  const distToResistance = Math.abs(zones.resistance - price) / price;
  const distToSupport = Math.abs(price - zones.support) / price;

  const nearResistance = distToResistance <= STRUCTURE_ENTRY_BUFFER;
  const nearSupport = distToSupport <= STRUCTURE_ENTRY_BUFFER;

  const inMiddle =
    price > (zones.support + zones.range * 0.3) &&
    price < (zones.resistance - zones.range * 0.3);

  if (inMiddle) {
    return {
      action: "WAIT",
      mode: "STRUCTURE",
      reason: "MID_ZONE_BLOCK",
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  if ((bias === "down" || bias === "down_soft") && nearResistance) {
    if (!isResistanceRejectionConfirmed(prices, zones.resistance)) {
      return {
        action: "WAIT",
        mode: "STRUCTURE",
        reason: "WAIT_REJECTION_CONFIRMATION",
        support: zones.support,
        resistance: zones.resistance,
      };
    }

    return {
      symbol,
      action: "SELL",
      mode: "STRUCTURE",
      confidence: 0.76,
      riskPct: 0.01,
      targetPrice: zones.support,
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  if ((bias === "up" || bias === "up_soft") && nearSupport) {
    if (!isSupportBounceConfirmed(prices, zones.support)) {
      return {
        action: "WAIT",
        mode: "STRUCTURE",
        reason: "WAIT_BOUNCE_CONFIRMATION",
        support: zones.support,
        resistance: zones.resistance,
      };
    }

    return {
      symbol,
      action: "BUY",
      mode: "STRUCTURE",
      confidence: 0.76,
      riskPct: 0.01,
      targetPrice: zones.resistance,
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  return {
    action: "WAIT",
    mode: "STRUCTURE",
    reason: "ZONE_NOT_READY",
    support: zones.support,
    resistance: zones.resistance,
  };
}

/* =========================================================
ENTRY QUALITY FILTER
========================================================= */

function isChasingMove(prices, action) {
  if (prices.length < 4) return false;

  const p0 = prices[prices.length - 1];
  const p1 = prices[prices.length - 2];
  const p2 = prices[prices.length - 3];

  const m1 = (p0 - p1) / p1;
  const m2 = (p1 - p2) / p2;

  if (action === "BUY") {
    return m1 > ENTRY_CHASE_BLOCK_PCT || m2 > ENTRY_CHASE_BLOCK_PCT;
  }

  if (action === "SELL") {
    return m1 < -ENTRY_CHASE_BLOCK_PCT || m2 < -ENTRY_CHASE_BLOCK_PCT;
  }

  return false;
}

function isExtendedFromBase(prices, action) {
  if (prices.length < ENTRY_EXTENSION_LOOKBACK) return false;

  const slice = prices.slice(-ENTRY_EXTENSION_LOOKBACK);
  const price = slice[slice.length - 1];
  const low = Math.min(...slice);
  const high = Math.max(...slice);

  if (action === "BUY") {
    return ((price - low) / low) >= ENTRY_EXTENSION_BLOCK_PCT;
  }

  if (action === "SELL") {
    return ((high - price) / high) >= ENTRY_EXTENSION_BLOCK_PCT;
  }

  return false;
}

/* =========================================================
CLOSE TRADE
========================================================= */

function closeTrade({ tenantId, state, symbol, price, ts }) {
  const closed = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action: "CLOSE",
    price,
    state,
    ts,
  });

  if (!closed?.result) return false;

  const pnl = Number(closed.result.pnl || 0);

  if (pnl < 0) {
    state.limits.lossesToday++;
  }

  state.lastTradeTime = ts;
  updateCapitalView(state, price);

  return true;
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
  if (!Number.isFinite(pos.takeProfitPct)) pos.takeProfitPct = NaN;
  if (!Number.isFinite(pos.maxDuration)) pos.maxDuration = computeDuration(0.5);
}

function updateBestPnl(pos, pnl) {
  if (pnl > pos.bestPnl) {
    pos.bestPnl = pnl;
  }
}

function computeWarningPrice(pos) {
  const pullbackPct =
    pos.mode === "STRUCTURE"
      ? STRUCTURE_WARNING_PULLBACK_PCT
      : WARNING_PULLBACK_PCT;

  if (pos.bestPnl > 0) {
    if (pos.side === "LONG") {
      return pos.entry * (1 + Math.max(0, pos.bestPnl - pullbackPct));
    }
    return pos.entry * (1 - Math.max(0, pos.bestPnl - pullbackPct));
  }

  if (pos.side === "LONG") return pos.entry * (1 - pullbackPct);
  return pos.entry * (1 + pullbackPct);
}

function isWarningTouched(pos, price) {
  if (!Number.isFinite(pos.warningPrice)) return false;

  if (pos.side === "LONG") return price <= pos.warningPrice;
  return price >= pos.warningPrice;
}

function protectProfitFloor(pos, strongTrend) {
  if (pos.bestPnl < STRUCTURE_BREAK_EVEN_PNL) return;

  const breakEvenFloor =
    pos.side === "LONG"
      ? pos.entry * 1.0002
      : pos.entry * 0.9998;

  if (pos.side === "LONG") {
    pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
      ? Math.max(pos.lockedProfitFloor, breakEvenFloor)
      : breakEvenFloor;
  } else {
    pos.lockedProfitFloor = Number.isFinite(pos.lockedProfitFloor)
      ? Math.min(pos.lockedProfitFloor, breakEvenFloor)
      : breakEvenFloor;
  }

  if (pos.bestPnl >= STRUCTURE_MIN_LOCK_PNL) {
    const lockPct = strongTrend ? 0.30 : STRUCTURE_PROFIT_LOCK;
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

function protectScalpProfitFloor(pos, strongTrend) {
  if (pos.bestPnl < SCALP_BREAK_EVEN_TRIGGER) return;

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
    const lockPct = strongTrend ? 0.25 : SCALP_LOCKED_PROFIT_PCT;
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

function getPnLPct(pos, price) {
  return pos.side === "LONG"
    ? (price - pos.entry) / pos.entry
    : (pos.entry - price) / pos.entry;
}

function reachedScalpTarget(pos, pnl, strongTrend) {
  const tp = Number.isFinite(pos.takeProfitPct)
    ? pos.takeProfitPct
    : SCALP_TAKE_PROFIT;

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
  return giveback >= (pos.bestPnl * RUNNER_GIVEBACK_PCT);
}

function handleStructurePosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  pos,
  pnl,
  elapsed,
  prices,
}) {
  const strongTrend = detectTrendRun(prices, pos.side, 4);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices, pos.side);
  const weakReversal = detectWeakReversal(prices, pos.side);

  initPositionRuntime(pos);
  updateBestPnl(pos, pnl);

  pos.warningPrice = computeWarningPrice(pos);

  if (pnl <= HARD_STOP_LOSS) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (elapsed < MIN_HOLD_TIME) return false;

  const targetPrice = safeNum(pos.targetPrice, NaN);

  if (Number.isFinite(targetPrice) && !pos.targetReached) {
    const longHit =
      pos.side === "LONG" &&
      price >= targetPrice * (1 - STRUCTURE_TARGET_BUFFER);

    const shortHit =
      pos.side === "SHORT" &&
      price <= targetPrice * (1 + STRUCTURE_TARGET_BUFFER);

    if (longHit || shortHit) {
      if (!strongTrend) {
        return closeTrade({ tenantId, state, symbol, price, ts });
      }

      pos.targetReached = true;
      pos.runnerConfirmed = true;
      pos.maxDuration = Math.min(
        pos.maxDuration + 60000,
        computeDuration(1) + MAX_EXTENSION_DURATION
      );
    }
  }

  if (pos.targetReached && strongTrend) {
    pos.warningTouches = 0;
    pos.runnerConfirmed = true;
    pos.maxDuration = Math.min(
      pos.maxDuration + 30000,
      computeDuration(1) + MAX_EXTENSION_DURATION
    );
  }

  if (pos.targetReached) {
    protectProfitFloor(pos, strongTrend);

    if (shouldExitByLockedFloor(pos, price)) {
      return closeTrade({ tenantId, state, symbol, price, ts });
    }

    if (shouldExitRunnerGiveback(pos, pnl)) {
      return closeTrade({ tenantId, state, symbol, price, ts });
    }

    if (isWarningTouched(pos, price) && !strongTrend) {
      pos.warningTouches += 1;
    } else if (strongTrend) {
      pos.warningTouches = 0;
    }

    if (
      pos.warningTouches >= RUNNER_CONFIRM_BARS &&
      (hardBreak || weakReversal || momentumWeak)
    ) {
      return closeTrade({ tenantId, state, symbol, price, ts });
    }

    if (pnl > 0 && hardBreak && !strongTrend && !pos.runnerConfirmed) {
      return closeTrade({ tenantId, state, symbol, price, ts });
    }

    if (elapsed >= pos.maxDuration) {
      return closeTrade({ tenantId, state, symbol, price, ts });
    }

    return false;
  }

  if (pnl > 0 && strongTrend) {
    pos.maxDuration = Math.min(
      pos.maxDuration + 30000,
      computeDuration(1) + MAX_EXTENSION_DURATION
    );
    return false;
  }

  if (
    pnl > 0 &&
    isWarningTouched(pos, price) &&
    (hardBreak || weakReversal) &&
    !strongTrend
  ) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (elapsed >= pos.maxDuration) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  return false;
}

function handleScalpPosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  pos,
  pnl,
  elapsed,
  prices,
}) {
  const strongTrend = detectTrendRun(prices, pos.side, 3);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices, pos.side);
  const weakReversal = detectWeakReversal(prices, pos.side);

  initPositionRuntime(pos);
  updateBestPnl(pos, pnl);

  pos.warningPrice = computeWarningPrice(pos);
  protectScalpProfitFloor(pos, strongTrend);

  if (pnl <= HARD_STOP_LOSS) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (elapsed < MIN_HOLD_TIME) return false;

  if (shouldExitByLockedFloor(pos, price)) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (reachedScalpTarget(pos, pnl, strongTrend)) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (shouldExitRunnerGiveback(pos, pnl)) {
    return closeTrade({ tenantId, state, symbol, price, ts });
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
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (
    pnl > 0 &&
    isWarningTouched(pos, price) &&
    !strongTrend &&
    (hardBreak || weakReversal)
  ) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  if (elapsed >= pos.maxDuration) {
    return closeTrade({ tenantId, state, symbol, price, ts });
  }

  return false;
}

/* =========================================================
OPEN POSITION
========================================================= */

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

  if (pos.mode === "STRUCTURE") {
    return handleStructurePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      pos,
      pnl,
      elapsed,
      prices,
    });
  }

  return handleScalpPosition({
    tenantId,
    state,
    symbol,
    price,
    ts,
    pos,
    pnl,
    elapsed,
    prices,
  });
}

/* =========================================================
TRADE DURATION
========================================================= */

function computeDuration(confidence) {
  const ratio = clamp(safeNum(confidence, 0), 0, 1);

  return Math.floor(
    MIN_TRADE_DURATION +
    ratio * (MAX_TRADE_DURATION - MIN_TRADE_DURATION)
  );
}

/* =========================================================
OPEN TRADE
========================================================= */

function openTrade({
  tenantId,
  state,
  symbol,
  action,
  mode,
  plan,
  price,
  ts,
}) {
  const exec = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action,
    price,
    riskPct: Number(plan.riskPct || 0.01),
    confidence: Number(plan.confidence || 0.5),
    state,
    ts,
  });

  if (exec?.result) {
    state.executionStats.trades++;
    state.limits.tradesToday++;
    state.lastMode = mode;

    if (state.position) {
      state.position.mode = mode;
      state.position.bestPnl = 0;
      state.position.targetPrice = safeNum(plan.targetPrice, NaN);
      state.position.structureSupport = safeNum(plan.support, NaN);
      state.position.structureResistance = safeNum(plan.resistance, NaN);
      state.position.targetReached = false;
      state.position.runnerConfirmed = false;
      state.position.lockedProfitFloor = NaN;
      state.position.warningPrice = NaN;
      state.position.warningTouches = 0;
      state.position.takeProfitPct =
        mode === "STRUCTURE" ? NaN : SCALP_TAKE_PROFIT;
      state.position.maxDuration =
        mode === "STRUCTURE"
          ? computeDuration(Math.max(0.85, safeNum(plan.confidence, 0.76)))
          : computeDuration(plan.confidence);
    }

    state.lastTradeTime = ts;
    updateCapitalView(state, price);

    return true;
  }

  return false;
}

/* =========================================================
TICK ENGINE
========================================================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);

  if (!state.running) return;
  if (!symbol) return;
  if (!Number.isFinite(price) || price <= 0) return;
  if (state._locked) return;

  state._locked = true;

  try {
    resetDailyLimitsIfNeeded(state, ts);

    const prev = safeNum(state.lastPriceBySymbol?.[symbol], NaN);
    state.lastPriceBySymbol[symbol] = price;

    const prices = recordPrice(tenantId, symbol, price);

    if (Number.isFinite(prev) && prev > 0) {
      const change = Math.abs(price - prev) / prev;

      state.volatility = Math.max(
        0.0005,
        state.volatility * 0.9 + change * 0.1
      );
    }

    state.executionStats.ticks++;

    if (state.position) {
      if (state.position.symbol === symbol) {
        state.executionStats.decisions++;

        recordDecision(
          state,
          {
            action: "MANAGE",
            mode: state.position.mode || "SCALP",
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

        updateCapitalView(state, price);
      }

      return;
    }

    let cooldown = COOLDOWN_AFTER_TRADE;

    if (state.limits.lossesToday >= LOSS_STREAK_SLOWDOWN) {
      cooldown += EXTRA_COOLDOWN_ON_LOSS_STREAK;
    }

    if (ts - state.lastTradeTime < cooldown) {
      updateCapitalView(state, price);
      return;
    }

    if (
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    ) {
      updateCapitalView(state, price);
      return;
    }

    const modePick = chooseTradeMode(prices);

    let plan = { action: "WAIT" };

    if (modePick.mode === "STRUCTURE") {
      plan = buildStructurePlan({
        price,
        zones: modePick.zones,
        bias: modePick.bias,
        symbol,
        prices,
      });
    }

    if (!["BUY", "SELL"].includes(plan.action)) {
      const scalpPlan =
        makeDecision({
          tenantId,
          symbol,
          last: price,
          paper: state,
        }) || { action: "WAIT" };

      plan = {
        ...scalpPlan,
        mode: "SCALP",
      };
    }

    if (
      ["BUY", "SELL"].includes(plan.action) &&
      (
        isChasingMove(prices, plan.action) ||
        isExtendedFromBase(prices, plan.action)
      )
    ) {
      plan = {
        ...plan,
        action: "WAIT",
        reason: "ENTRY_QUALITY_BLOCKED",
      };
    }

    state.executionStats.decisions++;

    recordDecision(
      state,
      {
        ...plan,
        mode: plan.mode || modePick.mode,
        symbol,
        price,
        volatility: state.volatility,
      },
      ts
    );

    if (!["BUY", "SELL"].includes(plan.action)) {
      updateCapitalView(state, price);
      return;
    }

    openTrade({
      tenantId,
      state,
      symbol,
      action: plan.action,
      mode: plan.mode || "SCALP",
      plan,
      price,
      ts,
    });

    updateCapitalView(state, price);
  } finally {
    state._locked = false;
  }
}

/* =========================================================
MANUAL RESET
========================================================= */

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  tick,
  snapshot,
  getDecisions,
  hardReset,
};
