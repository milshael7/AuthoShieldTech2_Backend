// -----------------------------------------------------------
// FILE: backend/src/services/tradeBrain.js
// VERSION: v24.1 (Faster Responsive Reversal Brain + Single-Trade Matched)
// PURPOSE
// - Keeps single-position matched flow
// - Faster reaction to live price changes
// - Less hesitant confidence smoothing
// - More trade participation without removing safety rails
// -----------------------------------------------------------

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 120);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 4);

const MAX_DRAWDOWN =
  Number(process.env.TRADE_MAX_DRAWDOWN || 0.08);

const VOLATILITY_SHUTDOWN =
  Number(process.env.TRADE_VOLATILITY_SHUTDOWN || 0.04);

const CRASH_MOVE =
  Number(process.env.TRADE_CRASH_MOVE || 0.04);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.42);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.52);

const MIN_CONFIDENCE_TO_TRADE =
  Number(process.env.TRADE_MIN_CONFIDENCE || 0.46);

const MAX_RISK =
  Number(process.env.TRADE_MAX_RISK || 0.06);

const MIN_RISK =
  Number(process.env.TRADE_MIN_RISK || 0.0015);

const TRADE_COOLDOWN_MS =
  Number(process.env.TRADE_COOLDOWN_MS || 6000);

const MIN_MOMENTUM_EDGE =
  Number(process.env.TRADE_MIN_EDGE || 0.00012);

/* ================= REVERSAL CONFIG ================= */

const REVERSAL_LOOKBACK =
  Number(process.env.TRADE_REVERSAL_LOOKBACK || 10);

const MIN_REVERSAL_CONFIDENCE =
  Number(process.env.TRADE_MIN_REVERSAL_CONFIDENCE || 0.50);

const EXTREME_NEARNESS_PCT =
  Number(process.env.TRADE_EXTREME_NEARNESS_PCT || 0.0022);

const ENTRY_CONFIRM_BARS =
  Number(process.env.TRADE_ENTRY_CONFIRM_BARS || 1);

const NOISE_BAND_PCT =
  Number(process.env.TRADE_NOISE_BAND_PCT || 0.00022);

const EARLY_EXIT_MIN_HOLD_MS =
  Number(process.env.TRADE_EARLY_EXIT_MIN_HOLD_MS || 9000);

const REVERSAL_FAIL_EDGE =
  Number(process.env.TRADE_REVERSAL_FAIL_EDGE || 0.00028);

const HARD_FAIL_PNL_PCT =
  Number(process.env.TRADE_HARD_FAIL_PNL_PCT || -0.0045);

const SOFT_FAIL_CONFIDENCE =
  Number(process.env.TRADE_SOFT_FAIL_CONFIDENCE || 0.34);

const EXPLORATION_RATE =
  Number(process.env.TRADE_EXPLORATION_RATE || 0.08);

/* ================= ACTIONS ================= */

const ACTIONS = new Set(["WAIT", "BUY", "SELL", "CLOSE"]);

/* ================= STATE ================= */

const BRAIN_STATE = new Map();

function normalizeTenantKey(tenantId) {
  return String(tenantId || "__default__");
}

function getBrainState(tenantId) {
  const key = normalizeTenantKey(tenantId);

  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.3,
      edgeMomentum: 0,
      lastAction: "WAIT",
      lastDecisionTime: 0,
      lastTradeTime: 0,
      priceMemory: [],
      lossStreak: 0,
      peakEquity: 0,
      lastReversalBias: "NONE",
    });
  }

  return BRAIN_STATE.get(key);
}

/* ================= UTIL ================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function avg(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;

  const valid = nums
    .map((n) => safeNum(n, NaN))
    .filter((n) => Number.isFinite(n));

  if (!valid.length) return 0;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function sum(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;

  const valid = nums
    .map((n) => safeNum(n, NaN))
    .filter((n) => Number.isFinite(n));

  if (!valid.length) return 0;

  return valid.reduce((a, b) => a + b, 0);
}

function getSingleActivePosition(paper = {}) {
  if (paper?.position) return paper.position;
  if (paper?.positions?.scalp) return paper.positions.scalp;
  if (paper?.positions?.structure) return paper.positions.structure;
  return null;
}

function normalizeAction(action) {
  const value = String(action || "WAIT").toUpperCase();
  return ACTIONS.has(value) ? value : "WAIT";
}

/* ================= PRICE MEMORY ================= */

function updatePriceMemory(brain, price) {
  if (!Number.isFinite(price) || price <= 0) return;

  brain.priceMemory.push(price);

  if (brain.priceMemory.length > 80) {
    brain.priceMemory.shift();
  }
}

function getRecentPrices(prices, size = REVERSAL_LOOKBACK) {
  if (!Array.isArray(prices)) return [];
  return prices.slice(-Math.max(3, safeNum(size, REVERSAL_LOOKBACK)));
}

function getMoves(prices) {
  const moves = [];

  for (let i = 1; i < prices.length; i += 1) {
    const prev = safeNum(prices[i - 1], NaN);
    const next = safeNum(prices[i], NaN);

    if (Number.isFinite(prev) && Number.isFinite(next)) {
      moves.push(next - prev);
    }
  }

  return moves;
}

function countDirectionalMoves(moves, side, noiseBand = 0) {
  let count = 0;

  for (const move of moves) {
    if (side === "UP" && move > noiseBand) count += 1;
    if (side === "DOWN" && move < -noiseBand) count += 1;
  }

  return count;
}

function getRunLength(moves, side, noiseBand = 0) {
  let run = 0;

  for (let i = moves.length - 1; i >= 0; i -= 1) {
    const move = safeNum(moves[i], 0);

    if (side === "UP" && move > noiseBand) {
      run += 1;
      continue;
    }

    if (side === "DOWN" && move < -noiseBand) {
      run += 1;
      continue;
    }

    break;
  }

  return run;
}

/* ================= SESSION INTELLIGENCE ================= */

function getSessionBoost() {
  const hour = new Date().getUTCHours();

  if (hour >= 12 && hour <= 16) return 1.1;
  if (hour >= 7 && hour < 12) return 1.06;

  return 1.0;
}

/* ================= EXECUTION ALPHA ================= */

function detectExecutionAlpha(prices) {
  if (!Array.isArray(prices) || prices.length < 4) return 1;

  const m1 =
    safeNum(prices[prices.length - 1], 0) -
    safeNum(prices[prices.length - 2], 0);

  const m2 =
    safeNum(prices[prices.length - 2], 0) -
    safeNum(prices[prices.length - 3], 0);

  if (Math.abs(m1) > Math.abs(m2) * 1.15) return 1.08;

  return 1;
}

/* ================= CRASH DETECTION ================= */

function detectCrash(prices) {
  if (!Array.isArray(prices) || prices.length < 5) return false;

  const first = safeNum(prices[prices.length - 5], NaN);
  const last = safeNum(prices[prices.length - 1], NaN);

  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) {
    return false;
  }

  const move = Math.abs((last - first) / first);
  return move > CRASH_MOVE;
}

/* ================= POSITION HELPERS ================= */

function getOpenPnlPct(position, price) {
  if (!position || !Number.isFinite(price) || price <= 0) return 0;

  const entry = safeNum(position.entry, NaN);
  if (!Number.isFinite(entry) || entry <= 0) return 0;

  if (position.side === "LONG") {
    return (price - entry) / entry;
  }

  if (position.side === "SHORT") {
    return (entry - price) / entry;
  }

  return 0;
}

/* ================= REVERSAL ANALYSIS ================= */

function analyzeReversal(prices, volatility = 0) {
  const recent = getRecentPrices(prices, REVERSAL_LOOKBACK);

  if (recent.length < 5) {
    return {
      bias: "NONE",
      confidence: 0,
      edge: 0,
      reason: "NOT_ENOUGH_DATA",
      topWeakening: false,
      bottomWeakening: false,
      nearHigh: false,
      nearLow: false,
      exhaustionUp: 0,
      exhaustionDown: 0,
      reversalUpScore: 0,
      reversalDownScore: 0,
    };
  }

  const moves = getMoves(recent);
  const lastPrice = safeNum(recent[recent.length - 1], 0);

  const noiseBand = Math.max(
    lastPrice * NOISE_BAND_PCT,
    lastPrice * safeNum(volatility, 0) * 0.04,
    0
  );

  const upCount = countDirectionalMoves(moves, "UP", noiseBand);
  const downCount = countDirectionalMoves(moves, "DOWN", noiseBand);

  const upRun = getRunLength(moves, "UP", noiseBand);
  const downRun = getRunLength(moves, "DOWN", noiseBand);

  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const last = safeNum(recent[recent.length - 1], 0);
  const prev = safeNum(recent[recent.length - 2], last);
  const range = Math.max(high - low, last * 0.0004);

  const nearHigh =
    high > 0 ? (high - last) / high <= EXTREME_NEARNESS_PCT : false;

  const nearLow =
    low > 0 ? (last - low) / low <= EXTREME_NEARNESS_PCT : false;

  const confirmBars = Math.max(1, ENTRY_CONFIRM_BARS);
  const last2 = moves.slice(-confirmBars);
  const last3 = moves.slice(-3);
  const prior3 = moves.slice(-6, -3);

  const recentUpEnergy = sum(last3.filter((x) => x > 0));
  const recentDownEnergyAbs = Math.abs(sum(last3.filter((x) => x < 0)));

  const priorUpEnergy = sum(prior3.filter((x) => x > 0));
  const priorDownEnergyAbs = Math.abs(sum(prior3.filter((x) => x < 0)));

  const upwardExhaustion =
    upCount >= 2 &&
    priorUpEnergy > 0 &&
    recentUpEnergy >= 0 &&
    recentUpEnergy < priorUpEnergy * 0.9;

  const downwardExhaustion =
    downCount >= 2 &&
    priorDownEnergyAbs > 0 &&
    recentDownEnergyAbs >= 0 &&
    recentDownEnergyAbs < priorDownEnergyAbs * 0.9;

  const freshDownConfirm =
    last2.length >= confirmBars &&
    last2.every((m) => m < -noiseBand);

  const freshUpConfirm =
    last2.length >= confirmBars &&
    last2.every((m) => m > noiseBand);

  const rejectionDown = last - prev < -noiseBand;
  const rejectionUp = last - prev > noiseBand;

  const topWeakening =
    nearHigh &&
    (upRun >= 2 || upCount >= 3) &&
    upwardExhaustion;

  const bottomWeakening =
    nearLow &&
    (downRun >= 2 || downCount >= 3) &&
    downwardExhaustion;

  let reversalDownScore = 0;
  let reversalUpScore = 0;

  if (nearHigh) reversalDownScore += 0.22;
  if (topWeakening) reversalDownScore += 0.22;
  if (freshDownConfirm) reversalDownScore += 0.26;
  if (rejectionDown) reversalDownScore += 0.14;
  if (upRun >= 2 || upCount >= 4) reversalDownScore += 0.10;

  if (nearLow) reversalUpScore += 0.22;
  if (bottomWeakening) reversalUpScore += 0.22;
  if (freshUpConfirm) reversalUpScore += 0.26;
  if (rejectionUp) reversalUpScore += 0.14;
  if (downRun >= 2 || downCount >= 4) reversalUpScore += 0.10;

  reversalDownScore = clamp(reversalDownScore, 0, 1);
  reversalUpScore = clamp(reversalUpScore, 0, 1);

  const edgeBase = range > 0 ? (last - avg(recent)) / range : 0;

  if (
    reversalDownScore >= MIN_REVERSAL_CONFIDENCE &&
    reversalDownScore > reversalUpScore
  ) {
    return {
      bias: "SHORT",
      confidence: reversalDownScore,
      edge: -Math.max(MIN_MOMENTUM_EDGE, Math.abs(edgeBase) * 0.45),
      reason: "TOP_WEAKNESS_REVERSAL",
      topWeakening,
      bottomWeakening,
      nearHigh,
      nearLow,
      exhaustionUp: upwardExhaustion ? 1 : 0,
      exhaustionDown: downwardExhaustion ? 1 : 0,
      reversalUpScore,
      reversalDownScore,
    };
  }

  if (
    reversalUpScore >= MIN_REVERSAL_CONFIDENCE &&
    reversalUpScore > reversalDownScore
  ) {
    return {
      bias: "LONG",
      confidence: reversalUpScore,
      edge: Math.max(MIN_MOMENTUM_EDGE, Math.abs(edgeBase) * 0.45),
      reason: "BOTTOM_WEAKNESS_REVERSAL",
      topWeakening,
      bottomWeakening,
      nearHigh,
      nearLow,
      exhaustionUp: upwardExhaustion ? 1 : 0,
      exhaustionDown: downwardExhaustion ? 1 : 0,
      reversalUpScore,
      reversalDownScore,
    };
  }

  return {
    bias: "NONE",
    confidence: Math.max(reversalUpScore, reversalDownScore) * 0.6,
    edge: 0,
    reason: "NO_CONFIRMED_REVERSAL",
    topWeakening,
    bottomWeakening,
    nearHigh,
    nearLow,
    exhaustionUp: upwardExhaustion ? 1 : 0,
    exhaustionDown: downwardExhaustion ? 1 : 0,
    reversalUpScore,
    reversalDownScore,
  };
}

/* ================= EXIT LOGIC ================= */

function shouldForceCloseOpenTrade({
  position,
  price,
  confidence,
  edge,
  now,
  reversal,
}) {
  if (!position) return false;

  const openedAt = safeNum(position.time, now);
  const openMs = now - openedAt;
  const pnlPct = getOpenPnlPct(position, price);

  if (pnlPct <= HARD_FAIL_PNL_PCT) {
    return true;
  }

  if (openMs < EARLY_EXIT_MIN_HOLD_MS) {
    return false;
  }

  if (
    confidence < SOFT_FAIL_CONFIDENCE &&
    Math.abs(edge) < MIN_MOMENTUM_EDGE
  ) {
    return true;
  }

  if (
    position.side === "LONG" &&
    reversal?.bias === "SHORT" &&
    safeNum(reversal?.confidence, 0) >= MIN_REVERSAL_CONFIDENCE &&
    edge <= -REVERSAL_FAIL_EDGE
  ) {
    return true;
  }

  if (
    position.side === "SHORT" &&
    reversal?.bias === "LONG" &&
    safeNum(reversal?.confidence, 0) >= MIN_REVERSAL_CONFIDENCE &&
    edge >= REVERSAL_FAIL_EDGE
  ) {
    return true;
  }

  return false;
}

/* ================= RISK GOVERNOR ================= */

function riskGovernor({
  brain,
  paper,
  volatility,
  prices,
}) {
  const equity = safeNum(
    paper?.equity,
    safeNum(paper?.cashBalance, 0)
  );

  if (!brain.peakEquity) {
    brain.peakEquity = equity;
  }

  if (equity > brain.peakEquity) {
    brain.peakEquity = equity;
  }

  const drawdown =
    brain.peakEquity > 0
      ? (brain.peakEquity - equity) / brain.peakEquity
      : 0;

  if (drawdown > MAX_DRAWDOWN) return "DRAWDOWN_LIMIT";
  if (brain.lossStreak >= MAX_LOSS_STREAK) return "LOSS_STREAK";
  if (safeNum(volatility, 0) > VOLATILITY_SHUTDOWN) return "VOLATILITY_SPIKE";
  if (detectCrash(prices)) return "CRASH_DETECTED";

  if (safeNum(paper?.limits?.tradesToday, 0) >= MAX_TRADES_PER_DAY) {
    return "MAX_TRADES_REACHED";
  }

  return null;
}

/* ================= AI OVERLAY ================= */

function getAiOverlay({ tenantId, symbol, last, paper }) {
  try {
    if (typeof aiBrain?.decide !== "function") {
      return { confidence: 0, edge: 0 };
    }

    const ai = aiBrain.decide({
      tenantId,
      symbol,
      last,
      paper,
    }) || {};

    return {
      confidence: safeNum(ai.confidence, 0),
      edge: safeNum(ai.edge, 0),
    };
  } catch {
    return { confidence: 0, edge: 0 };
  }
}

/* ================= DECISION ================= */

function makeDecision(context = {}) {
  const {
    tenantId,
    symbol = "BTCUSDT",
    last,
    paper = {},
  } = context;

  const brain = getBrainState(tenantId);
  const price = safeNum(last, NaN);
  const now = Date.now();

  if (!Number.isFinite(price) || price <= 0) {
    return {
      symbol,
      action: "WAIT",
      confidence: 0,
      edge: 0,
      riskPct: 0,
      reason: "INVALID_PRICE",
      stopLoss: null,
      takeProfit: null,
      reversal: {
        bias: "NONE",
        confidence: 0,
        nearHigh: false,
        nearLow: false,
        topWeakening: false,
        bottomWeakening: false,
        reversalUpScore: 0,
        reversalDownScore: 0,
      },
      ts: now,
    };
  }

  updatePriceMemory(brain, price);

  const prices = brain.priceMemory;
  const volatility = safeNum(paper?.volatility, 0);
  const activePosition = getSingleActivePosition(paper);

  const riskStop = riskGovernor({
    brain,
    paper,
    volatility,
    prices,
  });

  if (riskStop) {
    return {
      symbol,
      action: activePosition ? "CLOSE" : "WAIT",
      confidence: 0,
      edge: 0,
      riskPct: 0,
      reason: riskStop,
      stopLoss: null,
      takeProfit: null,
      reversal: {
        bias: "NONE",
        confidence: 0,
        nearHigh: false,
        nearLow: false,
        topWeakening: false,
        bottomWeakening: false,
        reversalUpScore: 0,
        reversalDownScore: 0,
      },
      ts: now,
    };
  }

  let strategy = {};

  try {
    strategy =
      buildDecision({
        tenantId,
        symbol,
        price,
        lastPrice: paper?.lastPrice,
        volatility,
        paperState: paper,
      }) || {};
  } catch {
    strategy = {};
  }

  const reversal = analyzeReversal(prices, volatility);
  brain.lastReversalBias = reversal.bias;

  let action = "WAIT";
  let confidence = safeNum(strategy?.confidence, 0.3);
  let edge = safeNum(strategy?.edge, 0);
  let riskPct = safeNum(strategy?.riskPct, 0.012);
  let reason = reversal.reason || "WAIT";

  let stopLoss =
    Number.isFinite(strategy?.stopLoss) ? Number(strategy.stopLoss) : null;

  let takeProfit =
    Number.isFinite(strategy?.takeProfit) ? Number(strategy.takeProfit) : null;

  if (reversal.bias === "SHORT") {
    action = "SELL";
    confidence = Math.max(confidence, safeNum(reversal.confidence, 0));
    edge = Math.min(edge, safeNum(reversal.edge, -MIN_MOMENTUM_EDGE));
    reason = reversal.reason;
  } else if (reversal.bias === "LONG") {
    action = "BUY";
    confidence = Math.max(confidence, safeNum(reversal.confidence, 0));
    edge = Math.max(edge, safeNum(reversal.edge, MIN_MOMENTUM_EDGE));
    reason = reversal.reason;
  } else {
    action = normalizeAction(strategy?.action || "WAIT");
    reason = strategy?.reason || reason;
  }

  if (Math.abs(edge) < MIN_MOMENTUM_EDGE && (action === "BUY" || action === "SELL")) {
    action = "WAIT";
  }

  const aiOverlay = getAiOverlay({
    tenantId,
    symbol,
    last,
    paper,
  });

  confidence = clamp(
    confidence * 0.86 + aiOverlay.confidence * 0.14,
    0,
    1
  );

  if (action === "BUY") {
    edge = clamp(
      Math.max(edge, edge * 0.88 + aiOverlay.edge * 0.12),
      -1,
      1
    );
  } else if (action === "SELL") {
    edge = clamp(
      Math.min(edge, edge * 0.88 + aiOverlay.edge * 0.12),
      -1,
      1
    );
  } else {
    edge = clamp(edge * 0.84 + aiOverlay.edge * 0.16, -1, 1);
  }

  confidence *= getSessionBoost();
  confidence *= detectExecutionAlpha(prices);

  brain.smoothedConfidence =
    brain.smoothedConfidence * CONFIDENCE_DECAY +
    confidence * (1 - CONFIDENCE_DECAY);

  confidence = clamp(brain.smoothedConfidence, 0, 1);

  brain.edgeMomentum =
    brain.edgeMomentum * EDGE_MEMORY_DECAY +
    edge * (1 - EDGE_MEMORY_DECAY);

  edge = clamp(brain.edgeMomentum, -1, 1);

  if (
    (action === "BUY" || action === "SELL") &&
    confidence < MIN_CONFIDENCE_TO_TRADE
  ) {
    action = "WAIT";
  }

  if (
    (action === "BUY" || action === "SELL") &&
    reversal.bias !== "NONE" &&
    confidence < MIN_REVERSAL_CONFIDENCE * 0.92
  ) {
    action = "WAIT";
  }

  if (
    !activePosition &&
    action === "WAIT" &&
    EXPLORATION_RATE > 0 &&
    Math.random() < EXPLORATION_RATE &&
    Math.abs(edge) > MIN_MOMENTUM_EDGE
  ) {
    action = edge > 0 ? "BUY" : "SELL";
    confidence = clamp(confidence * 0.82, 0.32, 0.62);
    riskPct = clamp(riskPct * 0.55, MIN_RISK, MAX_RISK);
    reason = "EXPLORATION_ENTRY";
  }

  if (confidence > 0.9) riskPct *= 1.45;
  else if (confidence > 0.8) riskPct *= 1.2;
  else if (confidence < 0.45) riskPct *= 0.7;

  if (reversal.bias !== "NONE") {
    riskPct *= 1.12;
  }

  riskPct = clamp(riskPct, MIN_RISK, MAX_RISK);

  if (activePosition) {
    if (action === "BUY" || action === "SELL") {
      action = "WAIT";
    }

    if (
      shouldForceCloseOpenTrade({
        position: activePosition,
        price,
        confidence,
        edge,
        now,
        reversal,
      })
    ) {
      action = "CLOSE";
      riskPct = 0;
      stopLoss = null;
      takeProfit = null;
      reason = "REVERSAL_FAILED_OR_SIGNAL_FLIPPED";
    } else if (action !== "CLOSE") {
      action = "WAIT";
      stopLoss = null;
      takeProfit = null;
    }
  } else {
    if (action === "CLOSE") {
      action = "WAIT";
    }

    if (now - safeNum(brain.lastTradeTime, 0) < TRADE_COOLDOWN_MS) {
      if (action === "BUY" || action === "SELL") {
        action = "WAIT";
        stopLoss = null;
        takeProfit = null;
      }
    }
  }

  if (!activePosition && (action === "BUY" || action === "SELL") && price > 0) {
    if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
      const stopDistancePct = clamp(
        Math.max(
          volatility * 1.15,
          NOISE_BAND_PCT * 2.5,
          0.0013
        ),
        0.0013,
        0.0075
      );

      const tpDistancePct = clamp(
        stopDistancePct * 1.45,
        0.002,
        0.012
      );

      if (action === "BUY") {
        stopLoss = price * (1 - stopDistancePct);
        takeProfit = price * (1 + tpDistancePct);
      }

      if (action === "SELL") {
        stopLoss = price * (1 + stopDistancePct);
        takeProfit = price * (1 - tpDistancePct);
      }
    }
  } else if (action !== "BUY" && action !== "SELL") {
    stopLoss = null;
    takeProfit = null;
  }

  if (action === "BUY" || action === "SELL") {
    brain.lastTradeTime = now;
  }

  brain.lastAction = action;
  brain.lastDecisionTime = now;

  return {
    symbol,
    action,
    confidence,
    edge,
    riskPct,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
    reason,
    reversal: {
      bias: reversal.bias,
      confidence: reversal.confidence,
      nearHigh: reversal.nearHigh,
      nearLow: reversal.nearLow,
      topWeakening: reversal.topWeakening,
      bottomWeakening: reversal.bottomWeakening,
      reversalUpScore: reversal.reversalUpScore,
      reversalDownScore: reversal.reversalDownScore,
    },
    ts: now,
  };
}

/* ================= RECORD TRADE RESULT ================= */

function recordTradeOutcome({
  tenantId,
  pnl,
}) {
  const brain = getBrainState(tenantId);

  if (safeNum(pnl, 0) > 0) {
    brain.lossStreak = 0;
  } else {
    brain.lossStreak += 1;
  }
}

function resetTenant(tenantId) {
  const key = normalizeTenantKey(tenantId);
  BRAIN_STATE.delete(key);

  return {
    ok: true,
    tenantId: key,
  };
}

module.exports = {
  makeDecision,
  resetTenant,
  recordTradeOutcome,
};
