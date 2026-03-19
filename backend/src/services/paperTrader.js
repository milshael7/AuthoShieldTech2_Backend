// ==========================================================
// FILE: backend/src/services/paperTrader.js
// VERSION: v46.0 (Matched to executionEngine v26.0)
// PURPOSE:
// - Compatible with slot-based execution engine
// - Uses SCALP slot for quick trades
// - Uses STRUCTURE slot for longer trades
// - Prevents mismatch with legacy single-position logic
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

/* =========================================================
STATE
========================================================= */

function defaultState() {
  return {
    running: true,
    cashBalance: START_BAL,
    availableCapital: START_BAL,
    lockedCapital: 0,
    equity: START_BAL,
    peakEquity: START_BAL,

    // new engine-compatible shape
    positions: {
      structure: null,
      scalp: null,
    },

    // legacy compatibility
    position: null,

    trades: [],
    decisions: [],
    volatility: 0.003,
    lastPrice: 60000,
    lastPriceBySymbol: {},
    lastTradeTime: 0,
    lastMode: "SCALP",

    realized: {
      wins: 0,
      losses: 0,
      net: 0,
      fees: 0,
    },

    limits: {
      tradesToday: 0,
      lossesToday: 0,
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
  if (STATES.has(tenantId)) return STATES.get(tenantId);

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

function normalizeSlot(slot) {
  const s = String(slot || "").toLowerCase();
  return s === "structure" ? "structure" : "scalp";
}

function ensurePositionsShape(state) {
  if (!state.positions || typeof state.positions !== "object") {
    state.positions = {
      structure: null,
      scalp: null,
    };
  }

  if (!("structure" in state.positions)) {
    state.positions.structure = null;
  }

  if (!("scalp" in state.positions)) {
    state.positions.scalp = null;
  }

  state.position =
    state.positions.structure ||
    state.positions.scalp ||
    null;
}

function getPosition(state, slot) {
  ensurePositionsShape(state);
  return state.positions[normalizeSlot(slot)] || null;
}

function hasOpenPosition(state, slot) {
  return !!getPosition(state, slot);
}

function recordDecision(state, plan) {
  state.decisions.push({
    ...plan,
    time: Date.now(),
  });

  if (state.decisions.length > 200) {
    state.decisions.shift();
  }
}

function snapshot(tenantId) {
  return load(tenantId);
}

function getDecisions(tenantId) {
  return load(tenantId).decisions || [];
}

/* =========================================================
PRICE MEMORY
========================================================= */

const PRICE_HISTORY = new Map();

function recordPrice(tenantId, price) {
  const key = tenantId || "__default__";

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

  return Math.abs(m1) < Math.abs(m2) &&
         Math.abs(m2) < Math.abs(m3);
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

  if (range <= 0) return null;

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
    ["up", "down", "up_soft", "down_soft"].includes(bias)
  ) {
    return { mode: "STRUCTURE", zones, bias };
  }

  return { mode: "SCALP", zones, bias };
}

function buildStructurePlan({ price, zones, bias, symbol }) {
  if (!zones) {
    return { action: "WAIT", mode: "STRUCTURE", slot: "structure", reason: "NO_ZONES" };
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
      slot: "structure",
      reason: "MID_ZONE_BLOCK",
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  if ((bias === "down" || bias === "down_soft") && nearResistance) {
    return {
      symbol,
      action: "SELL",
      mode: "STRUCTURE",
      slot: "structure",
      confidence: 0.72,
      riskPct: 0.01,
      targetPrice: zones.support,
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  if ((bias === "up" || bias === "up_soft") && nearSupport) {
    return {
      symbol,
      action: "BUY",
      mode: "STRUCTURE",
      slot: "structure",
      confidence: 0.72,
      riskPct: 0.01,
      targetPrice: zones.resistance,
      support: zones.support,
      resistance: zones.resistance,
    };
  }

  return {
    action: "WAIT",
    mode: "STRUCTURE",
    slot: "structure",
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

/* =========================================================
POSITION RUNTIME HELPERS
========================================================= */

function initPositionRuntime(pos) {
  if (!Number.isFinite(pos.bestPnl)) pos.bestPnl = 0;
  if (!Number.isFinite(pos.lockedProfitFloor)) pos.lockedProfitFloor = NaN;
  if (!Number.isFinite(pos.warningPrice)) pos.warningPrice = NaN;
  if (typeof pos.targetReached !== "boolean") pos.targetReached = false;
  if (typeof pos.runnerConfirmed !== "boolean") pos.runnerConfirmed = false;
  if (!Number.isFinite(pos.warningTouches)) pos.warningTouches = 0;
  if (!Number.isFinite(pos.maxDuration)) {
    pos.maxDuration = computeDuration(0.5);
  }
}

function updateBestPnl(pos, pnl) {
  if (pnl > pos.bestPnl) {
    pos.bestPnl = pnl;
  }
}

function computeWarningPrice(pos) {
  const pullbackPct =
    pos.slot === "structure"
      ? STRUCTURE_WARNING_PULLBACK_PCT
      : WARNING_PULLBACK_PCT;

  if (pos.side === "LONG") {
    return pos.entry * (1 - pullbackPct);
  }

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
    pos.lockedProfitFloor =
      Number.isFinite(pos.lockedProfitFloor)
        ? Math.max(pos.lockedProfitFloor, breakEvenFloor)
        : breakEvenFloor;
  } else {
    pos.lockedProfitFloor =
      Number.isFinite(pos.lockedProfitFloor)
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
      pos.lockedProfitFloor =
        Number.isFinite(pos.lockedProfitFloor)
          ? Math.max(pos.lockedProfitFloor, floorFromPnl)
          : floorFromPnl;
    } else {
      pos.lockedProfitFloor =
        Number.isFinite(pos.lockedProfitFloor)
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

/* =========================================================
CLOSE TRADE
========================================================= */

function closeTrade({
  tenantId,
  state,
  symbol,
  price,
  ts,
  slot,
  reason = "CLOSE",
}) {
  const closed = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action: reason,
    price,
    state,
    ts,
    slot,
  });

  if (!closed?.result && !closed?.results?.length) return false;

  const results = closed.results || [closed.result];

  for (const trade of results) {
    const pnl = Number(trade?.pnl || 0);
    if (pnl < 0) {
      state.limits.lossesToday++;
    }
  }

  state.lastTradeTime = ts;

  return true;
}

/* =========================================================
POSITION MANAGEMENT
========================================================= */

function handleStructurePosition({
  tenantId,
  state,
  symbol,
  price,
  ts,
  pos,
  elapsed,
  prices,
}) {
  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry
      : (pos.entry - price) / pos.entry;

  const strongTrend = detectTrendRun(prices, pos.side, 4);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices, pos.side);
  const weakReversal = detectWeakReversal(prices, pos.side);

  initPositionRuntime(pos);
  updateBestPnl(pos, pnl);

  pos.warningPrice = computeWarningPrice(pos);

  if (pnl <= HARD_STOP_LOSS) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      slot: "structure",
      reason: "CLOSE",
    });
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
      pos.targetReached = true;
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
      return closeTrade({
        tenantId,
        state,
        symbol,
        price,
        ts,
        slot: "structure",
        reason: "CLOSE",
      });
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
      return closeTrade({
        tenantId,
        state,
        symbol,
        price,
        ts,
        slot: "structure",
        reason: "CLOSE",
      });
    }

    if (pnl > 0 && hardBreak && !strongTrend) {
      return closeTrade({
        tenantId,
        state,
        symbol,
        price,
        ts,
        slot: "structure",
        reason: "CLOSE",
      });
    }

    if (elapsed >= pos.maxDuration) {
      return closeTrade({
        tenantId,
        state,
        symbol,
        price,
        ts,
        slot: "structure",
        reason: "CLOSE",
      });
    }

    return false;
  }

  if (isWarningTouched(pos, price) && !strongTrend) {
    pos.warningTouches += 1;
  } else if (strongTrend) {
    pos.warningTouches = 0;
  }

  if (pos.warningTouches >= RUNNER_CONFIRM_BARS && (hardBreak || weakReversal)) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      slot: "structure",
      reason: "CLOSE",
    });
  }

  if (strongTrend && pnl > 0) {
    pos.maxDuration = Math.min(
      pos.maxDuration + 30000,
      computeDuration(1) + MAX_EXTENSION_DURATION
    );
  }

  if (elapsed >= pos.maxDuration) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      slot: "structure",
      reason: "CLOSE",
    });
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
  elapsed,
  prices,
}) {
  const pnl =
    pos.side === "LONG"
      ? (price - pos.entry) / pos.entry
      : (pos.entry - price) / pos.entry;

  const strongTrend = detectTrendRun(prices, pos.side, 3);
  const momentumWeak = detectMomentumWeakening(prices);
  const hardBreak = detectHardMomentumBreak(prices, pos.side);
  const weakReversal = detectWeakReversal(prices, pos.side);

  initPositionRuntime(pos);
  updateBestPnl(pos, pnl);

  pos.warningPrice = computeWarningPrice(pos);

  if (pnl <= HARD_STOP_LOSS) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      slot: "scalp",
      reason: "CLOSE",
    });
  }

  if (elapsed < MIN_HOLD_TIME) return false;

  if (strongTrend && pnl > 0) {
    pos.maxDuration = Math.min(
      pos.maxDuration + 20000,
      computeDuration(1) + MAX_EXTENSION_DURATION
    );
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
      slot: "scalp",
      reason: "CLOSE",
    });
  }

  if (
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
      slot: "scalp",
      reason: "CLOSE",
    });
  }

  if (elapsed >= pos.maxDuration) {
    return closeTrade({
      tenantId,
      state,
      symbol,
      price,
      ts,
      slot: "scalp",
      reason: "CLOSE",
    });
  }

  return false;
}

function handleOpenPositions({
  tenantId,
  state,
  symbol,
  price,
  ts,
}) {
  let closedSomething = false;
  const prices = recordPrice(tenantId, price);

  const structurePos = getPosition(state, "structure");
  if (structurePos && structurePos.symbol === symbol) {
    const elapsed = ts - structurePos.time;
    const closed = handleStructurePosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      pos: structurePos,
      elapsed,
      prices,
    });
    if (closed) closedSomething = true;
  }

  const scalpPos = getPosition(state, "scalp");
  if (scalpPos && scalpPos.symbol === symbol) {
    const elapsed = ts - scalpPos.time;
    const closed = handleScalpPosition({
      tenantId,
      state,
      symbol,
      price,
      ts,
      pos: scalpPos,
      elapsed,
      prices,
    });
    if (closed) closedSomething = true;
  }

  return closedSomething;
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
  slot,
  plan,
  price,
  ts,
}) {
  const normalizedSlot = normalizeSlot(slot);

  const exec = executionEngine.executePaperOrder({
    tenantId,
    symbol,
    action,
    price,
    riskPct: Number(plan.riskPct || 0.01),
    confidence: Number(plan.confidence || 0.5),
    stopLoss: Number.isFinite(Number(plan.stopLoss)) ? Number(plan.stopLoss) : undefined,
    takeProfit: Number.isFinite(Number(plan.takeProfit)) ? Number(plan.takeProfit) : undefined,
    slot: normalizedSlot,
    state,
    ts,
  });

  if (exec?.result) {
    state.executionStats.trades++;
    state.limits.tradesToday++;
    state.lastMode = mode;

    const pos = getPosition(state, normalizedSlot);

    if (pos) {
      pos.mode = mode;
      pos.slot = normalizedSlot;
      pos.bestPnl = 0;
      pos.targetPrice = safeNum(plan.targetPrice, NaN);
      pos.structureSupport = safeNum(plan.support, NaN);
      pos.structureResistance = safeNum(plan.resistance, NaN);
      pos.targetReached = false;
      pos.runnerConfirmed = false;
      pos.lockedProfitFloor = NaN;
      pos.warningPrice = NaN;
      pos.warningTouches = 0;
      pos.maxDuration =
        normalizedSlot === "structure"
          ? computeDuration(Math.max(0.85, safeNum(plan.confidence, 0.72)))
          : computeDuration(plan.confidence);
    }

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
  if (!Number.isFinite(price) || price <= 0) return;
  if (state._locked) return;

  state._locked = true;

  try {
    ensurePositionsShape(state);

    const prev = state.lastPrice;
    state.lastPrice = price;
    state.lastPriceBySymbol[symbol] = price;

    const prices = recordPrice(tenantId, price);

    if (prev) {
      const change = Math.abs(price - prev) / prev;
      state.volatility = Math.max(
        0.0005,
        state.volatility * 0.9 + change * 0.1
      );
    }

    state.executionStats.ticks++;

    // Let execution engine process protective exits on HOLD/WAIT sync as needed
    executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action: "HOLD",
      price,
      state,
      ts,
    });

    handleOpenPositions({
      tenantId,
      state,
      symbol,
      price,
      ts,
    });

    let cooldown = COOLDOWN_AFTER_TRADE;

    if (state.limits.lossesToday >= LOSS_STREAK_SLOWDOWN) {
      cooldown += EXTRA_COOLDOWN_ON_LOSS_STREAK;
    }

    if (ts - state.lastTradeTime < cooldown) return;

    if (
      state.limits.tradesToday >= MAX_TRADES_PER_DAY ||
      state.limits.lossesToday >= MAX_DAILY_LOSSES
    ) {
      return;
    }

    const modePick = chooseTradeMode(prices);

    let structurePlan = { action: "WAIT", mode: "STRUCTURE", slot: "structure" };
    if (!hasOpenPosition(state, "structure") && modePick.mode === "STRUCTURE") {
      structurePlan = buildStructurePlan({
        price,
        zones: modePick.zones,
        bias: modePick.bias,
        symbol,
      });
    }

    let scalpPlan = { action: "WAIT", mode: "SCALP", slot: "scalp" };
    if (!hasOpenPosition(state, "scalp")) {
      const brainPlan =
        makeDecision({
          tenantId,
          symbol,
          last: price,
          paper: state,
        }) || { action: "WAIT" };

      scalpPlan = {
        ...brainPlan,
        mode: "SCALP",
        slot: "scalp",
      };
    }

    if (
      ["BUY", "SELL"].includes(structurePlan.action) &&
      isChasingMove(prices, structurePlan.action)
    ) {
      structurePlan = {
        ...structurePlan,
        action: "WAIT",
        reason: "CHASE_BLOCKED",
      };
    }

    if (
      ["BUY", "SELL"].includes(scalpPlan.action) &&
      isChasingMove(prices, scalpPlan.action)
    ) {
      scalpPlan = {
        ...scalpPlan,
        action: "WAIT",
        reason: "CHASE_BLOCKED",
      };
    }

    state.executionStats.decisions += 2;

    recordDecision(state, {
      ...structurePlan,
      price,
      volatility: state.volatility,
    });

    recordDecision(state, {
      ...scalpPlan,
      price,
      volatility: state.volatility,
    });

    if (
      ["BUY", "SELL"].includes(structurePlan.action) &&
      !hasOpenPosition(state, "structure")
    ) {
      openTrade({
        tenantId,
        state,
        symbol,
        action: structurePlan.action,
        mode: "STRUCTURE",
        slot: "structure",
        plan: structurePlan,
        price,
        ts,
      });
    }

    if (
      ["BUY", "SELL"].includes(scalpPlan.action) &&
      !hasOpenPosition(state, "scalp")
    ) {
      openTrade({
        tenantId,
        state,
        symbol,
        action: scalpPlan.action,
        mode: "SCALP",
        slot: "scalp",
        plan: scalpPlan,
        price,
        ts,
      });
    }
  } finally {
    state._locked = false;
  }
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  tick,
  snapshot,
  getDecisions,
};
