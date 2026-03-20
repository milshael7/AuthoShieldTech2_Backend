// -----------------------------------------------------------
// FILE: backend/src/services/tradeBrain.js
// VERSION: v23.0 (Reversal Weakness Brain + Single-Trade Matched)
// Matched to single-position paperTrader + executionEngine v26
// -----------------------------------------------------------

const aiBrain = require("../../brain/aiBrain");
const { buildDecision } = require("./strategyEngine");

/* ================= CONFIG ================= */

const MAX_TRADES_PER_DAY =
  Number(process.env.TRADE_MAX_TRADES_PER_DAY || 80);

const MAX_LOSS_STREAK =
  Number(process.env.TRADE_MAX_LOSS_STREAK || 3);

const MAX_DRAWDOWN =
  Number(process.env.TRADE_MAX_DRAWDOWN || 0.08);

const VOLATILITY_SHUTDOWN =
  Number(process.env.TRADE_VOLATILITY_SHUTDOWN || 0.03);

const CRASH_MOVE =
  Number(process.env.TRADE_CRASH_MOVE || 0.03);

const CONFIDENCE_DECAY =
  Number(process.env.TRADE_CONFIDENCE_DECAY || 0.72);

const EDGE_MEMORY_DECAY =
  Number(process.env.TRADE_EDGE_MEMORY_DECAY || 0.86);

const MIN_CONFIDENCE_TO_TRADE =
  Number(process.env.TRADE_MIN_CONFIDENCE || 0.58);

const MAX_RISK = 0.06;
const MIN_RISK = 0.001;

const TRADE_COOLDOWN_MS =
  Number(process.env.TRADE_COOLDOWN_MS || 20000);

const MIN_MOMENTUM_EDGE =
  Number(process.env.TRADE_MIN_EDGE || 0.00025);

/* ================= REVERSAL CONFIG ================= */

const REVERSAL_LOOKBACK =
  Number(process.env.TRADE_REVERSAL_LOOKBACK || 12);

const MIN_REVERSAL_CONFIDENCE =
  Number(process.env.TRADE_MIN_REVERSAL_CONFIDENCE || 0.64);

const EXTREME_NEARNESS_PCT =
  Number(process.env.TRADE_EXTREME_NEARNESS_PCT || 0.0018);

const ENTRY_CONFIRM_BARS =
  Number(process.env.TRADE_ENTRY_CONFIRM_BARS || 2);

const NOISE_BAND_PCT =
  Number(process.env.TRADE_NOISE_BAND_PCT || 0.00035);

const EARLY_EXIT_MIN_HOLD_MS =
  Number(process.env.TRADE_EARLY_EXIT_MIN_HOLD_MS || 15000);

const REVERSAL_FAIL_EDGE =
  Number(process.env.TRADE_REVERSAL_FAIL_EDGE || 0.00045);

const HARD_FAIL_PNL_PCT =
  Number(process.env.TRADE_HARD_FAIL_PNL_PCT || -0.0045);

const SOFT_FAIL_CONFIDENCE =
  Number(process.env.TRADE_SOFT_FAIL_CONFIDENCE || 0.40);

const EXPLORATION_RATE =
  Number(process.env.TRADE_EXPLORATION_RATE || 0);

/* ================= ACTIONS ================= */

const ACTIONS = new Set(["WAIT", "BUY", "SELL", "CLOSE"]);

/* ================= STATE ================= */

const BRAIN_STATE = new Map();

function getBrainState(tenantId) {
  const key = tenantId || "__default__";

  if (!BRAIN_STATE.has(key)) {
    BRAIN_STATE.set(key, {
      smoothedConfidence: 0.25,
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
  return nums.reduce((a, b) => a + safeNum(b, 0), 0) / nums.length;
}

function sum(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;
  return nums.reduce((a, b) => a + safeNum(b, 0), 0);
}

function getSingleActivePosition(paper = {}) {
  if (paper?.position) return paper.position;
  if (paper?.positions?.scalp) return paper.positions.scalp;
  if (paper?.positions?.structure) return paper.positions.structure;
  return null;
}

/* ================= PRICE MEMORY ================= */

function updatePriceMemory(brain, price) {
  if (!Number.isFinite(price) || price <= 0) return;

  brain.priceMemory.push(price);

  if (brain.priceMemory.length > 60) {
    brain.priceMemory.shift();
  }
}

function getRecentPrices(prices, size = REVERSAL_LOOKBACK) {
  if (!Array.isArray(prices)) return [];
  return prices.slice(-Math.max(3, size));
}

function getMoves(prices) {
  const moves = [];

  for (let i = 1; i < prices.length; i++) {
    moves.push(safeNum(prices[i], 0) - safeNum(prices[i - 1], 0));
  }

  return moves;
}

function countDirectionalMoves(moves, side, noiseBand = 0) {
  let count = 0;

  for (const move of moves) {
    if (side === "UP" && move > noiseBand) count++;
    if (side === "DOWN" && move < -noiseBand) count++;
  }

  return count;
}

function getRunLength(moves, side, noiseBand = 0) {
  let run = 0;

  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i];

    if (side === "UP" && move > noiseBand) {
      run++;
      continue;
    }

    if (side === "DOWN" && move < -noiseBand) {
      run++;
      continue;
    }

    break;
  }

  return run;
}

/* ================= SESSION INTELLIGENCE ================= */

function getSessionBoost() {
  const hour = new Date().getUTCHours();

  if (hour >= 12 && hour <= 16) return 1.08;
  if (hour >= 7 && hour < 12) return 1.05;

  return 0.98;
}

/* ================= EXECUTION ALPHA ================= */

function detectExecutionAlpha(prices) {
  if (prices.length < 4) return 1;

  const m1 = prices[prices.length - 1] - prices[prices.length - 2];
  const m2 = prices[prices.length - 2] - prices[prices.length - 3];

  if (Math.abs(m1) > Math.abs(m2) * 1.3) return 1.05;

  return 1;
}

/* ================= CRASH DETECTION ================= */

function detectCrash(prices) {
  if (prices.length < 5) return false;

  const first = prices[prices.length - 5];
  const last = prices[prices.length - 1];

  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) {
    return false;
  }

  const move = Math.abs((last - first) / first);
  return move > CRASH_MOVE;
}

/* ================= POSITION HELPERS ================= */

function getOpenPnlPct(position, price) {
  if (!position || !Number.isFinite(price) || price <= 0) return 0;
  if (!Number.isFinite(position.entry) || position.entry <= 0) return 0;

  if (position.side === "LONG") {
    return (price - position.entry) / position.entry;
  }

  if (position.side === "SHORT") {
    return (position.entry - price) / position.entry;
  }

  return 0;
}

/* ================= REVERSAL ANALYSIS ================= */

function analyzeReversal(prices, volatility = 0) {
  const recent = getRecentPrices(prices, REVERSAL_LOOKBACK);

  if (recent.length < 6) {
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
  const noiseBand = Math.max(
    safeNum(recent[recent.length - 1], 0) * NOISE_BAND_PCT,
    safeNum(recent[recent.length - 1], 0) * volatility * 0.05,
    0
  );

  const upCount = countDirectionalMoves(moves, "UP", noiseBand);
  const downCount = countDirectionalMoves(moves, "DOWN", noiseBand);

  const upRun = getRunLength(moves, "UP", noiseBand);
  const downRun = getRunLength(moves, "DOWN", noiseBand);

  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const range = Math.max(high - low, last * 0.0005);

  const nearHigh = high > 0
    ? ((high - last) / high) <= EXTREME_NEARNESS_PCT
    : false;

  const nearLow = low > 0
    ? ((last - low) / low) <= EXTREME_NEARNESS_PCT
    : false;

  const last3 = moves.slice(-3);
  const last2 = moves.slice(-2);

  const prior3 = moves.slice(-6, -3);
  const recentUpEnergy = sum(last3.filter((x) => x > 0));
  const recentDownEnergyAbs = Math.abs(sum(last3.filter((x) => x < 0)));

  const priorUpEnergy = sum(prior3.filter((x) => x > 0));
  const priorDownEnergyAbs = Math.abs(sum(prior3.filter((x) => x < 0)));

  const upwardExhaustion =
    upCount >= 3 &&
    priorUpEnergy > 0 &&
    recentUpEnergy >= 0 &&
    recentUpEnergy < priorUpEnergy * 0.8;

  const downwardExhaustion =
    downCount >= 3 &&
    priorDownEnergyAbs > 0 &&
    recentDownEnergyAbs >= 0 &&
    recentDownEnergyAbs < priorDownEnergyAbs * 0.8;

  const freshDownConfirm =
    last2.length >= ENTRY_CONFIRM_BARS &&
    last2.every((m) => m < -noiseBand);

  const freshUpConfirm =
    last2.length >= ENTRY_CONFIRM_BARS &&
    last2.every((m) => m > noiseBand);

  const rejectionDown =
    safeNum(last - prev, 0) < -noiseBand;

  const rejectionUp =
    safeNum(last - prev, 0) > noiseBand;

  const topWeakening =
    nearHigh &&
    (upRun >= 2 || upCount >= 4) &&
    upwardExhaustion;

  const bottomWeakening =
    nearLow &&
    (downRun >= 2 || downCount >= 4) &&
    downwardExhaustion;

  let reversalDownScore = 0;
  let reversalUpScore = 0;

  if (nearHigh) reversalDownScore += 0.24;
  if (topWeakening) reversalDownScore += 0.24;
  if (freshDownConfirm) reversalDownScore += 0.28;
  if (rejectionDown) reversalDownScore += 0.12;
  if (upRun >= 3 || upCount >= 5) reversalDownScore += 0.08;

  if (nearLow) reversalUpScore += 0.24;
  if (bottomWeakening) reversalUpScore += 0.24;
  if (freshUpConfirm) reversalUpScore += 0.28;
  if (rejectionUp) reversalUpScore += 0.12;
  if (downRun >= 3 || downCount >= 5) reversalUpScore += 0.08;

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
      edge: -Math.max(MIN_MOMENTUM_EDGE, Math.abs(edgeBase) * 0.35),
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
      edge: Math.max(MIN_MOMENTUM_EDGE, Math.abs(edgeBase) * 0.35),
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
    confidence: Math.max(reversalUpScore, reversalDownScore) * 0.5,
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

  const openMs = now - safeNum(position.time, now);
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
  const equity =
    safeNum(
      paper.equity,
      safeNum(paper.cashBalance, 0)
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
  if (volatility > VOLATILITY_SHUTDOWN) return "VOLATILITY_SPIKE";
  if (detectCrash(prices)) return "CRASH_DETECTED";

  if (safeNum(paper?.limits?.tradesToday, 0) >= MAX_TRADES_PER_DAY) {
    return "MAX_TRADES_REACHED";
  }

  return null;
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

  updatePriceMemory(brain, price);

  const prices = brain.priceMemory;
  const volatility = safeNum(paper.volatility, 0);
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
        lastPrice: paper.lastPrice,
        volatility,
        paperState: paper,
      }) || {};
  } catch {
    strategy = {};
  }

  const reversal = analyzeReversal(prices, volatility);
  brain.lastReversalBias = reversal.bias;

  let action = "WAIT";
  let confidence = safeNum(strategy.confidence, 0.25);
  let edge = safeNum(strategy.edge, 0);
  let riskPct = safeNum(strategy.riskPct, 0.01);
  let reason = reversal.reason || "WAIT";

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
    action = strategy.action || "WAIT";
    reason = strategy.reason || reason;
  }

  if (!ACTIONS.has(action)) {
    action = "WAIT";
  }

  if (Math.abs(edge) < MIN_MOMENTUM_EDGE && (action === "BUY" || action === "SELL")) {
    action = "WAIT";
  }

  /* ================= AI OVERLAY ================= */

  try {
    const ai =
      aiBrain.decide({
        tenantId,
        symbol,
        last,
        paper,
      }) || {};

    const aiConfidence = safeNum(ai.confidence, 0);
    const aiEdge = safeNum(ai.edge, 0);

    confidence = clamp(
      (confidence * 0.78) + (aiConfidence * 0.22),
      0,
      1
    );

    if (action === "BUY") {
      edge = clamp(
        Math.max(edge, (edge * 0.82) + (aiEdge * 0.18)),
        -1,
        1
      );
    } else if (action === "SELL") {
      edge = clamp(
        Math.min(edge, (edge * 0.82) + (aiEdge * 0.18)),
        -1,
        1
      );
    } else {
      edge = clamp(
        (edge * 0.78) + (aiEdge * 0.22),
        -1,
        1
      );
    }
  } catch {}

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
    confidence < MIN_REVERSAL_CONFIDENCE
  ) {
    action = "WAIT";
  }

  /* ================= OPTIONAL EXPLORATION ================= */

  if (
    !activePosition &&
    action === "WAIT" &&
    EXPLORATION_RATE > 0 &&
    Math.random() < EXPLORATION_RATE &&
    Math.abs(edge) > MIN_MOMENTUM_EDGE * 1.2
  ) {
    action = edge > 0 ? "BUY" : "SELL";
    confidence = clamp(confidence * 0.7, 0.25, 0.55);
    riskPct = clamp(riskPct * 0.5, MIN_RISK, MAX_RISK);
    reason = "EXPLORATION_ENTRY";
  }

  /* ================= RISK SCALING ================= */

  if (confidence > 0.90) riskPct *= 1.55;
  else if (confidence > 0.80) riskPct *= 1.2;
  else if (confidence < 0.50) riskPct *= 0.5;

  if (reversal.bias !== "NONE") {
    riskPct *= 1.1;
  }

  riskPct = clamp(riskPct, MIN_RISK, MAX_RISK);

  /* ================= SINGLE-TRADE ENFORCEMENT ================= */

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
      reason = "REVERSAL_FAILED_OR_SIGNAL_FLIPPED";
    } else if (action !== "CLOSE") {
      action = "WAIT";
    }
  } else {
    if (action === "CLOSE") {
      action = "WAIT";
    }

    if (now - safeNum(brain.lastTradeTime, 0) < TRADE_COOLDOWN_MS) {
      if (action === "BUY" || action === "SELL") {
        action = "WAIT";
      }
    }
  }

  /* ================= AUTO STOP / TP PLANNING ================= */

  let stopLoss;
  let takeProfit;

  if (!activePosition && (action === "BUY" || action === "SELL") && price > 0) {
    const stopDistancePct = clamp(
      Math.max(
        volatility * 1.35,
        NOISE_BAND_PCT * 3,
        0.0016
      ),
      0.0016,
      0.0085
    );

    const tpDistancePct = clamp(
      stopDistancePct * 1.6,
      0.0024,
      0.014
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
    stopLoss,
    takeProfit,
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
  BRAIN_STATE.delete(tenantId);
}

module.exports = {
  makeDecision,
  resetTenant,
  recordTradeOutcome,
};
