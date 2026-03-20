// ==========================================================
// FILE: backend/src/services/trainingEngine.js
// VERSION: v2.1 (Maintenance-Safe AI Training Engine)
// PURPOSE
// - Run historical candle simulations for AI / strategy learning
// - Track opens, closes, wins, losses, pnl, and durations
// - Support both aiBrain.decide and external decision builders
// - Safe for maintenance, inspection, and future strategy evolution
//
// FIXES
// - Hardened candle normalization and fallback handling
// - Prevented invalid stat drift on empty/partial data
// - Added strategy-safe threshold normalization
// - Added per-trade max hold override support
// - Added cleaner replay compatibility
// - Kept response shape stable for maintenance/frontend use
// ==========================================================

const replayEngine = require("./marketReplayEngine");
const aiBrain = require("../../brain/aiBrain");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const DEFAULT_STOP_LOSS_PCT = Number(
  process.env.TRAINING_DEFAULT_STOP_LOSS_PCT || 0.004
);

const DEFAULT_TAKE_PROFIT_PCT = Number(
  process.env.TRAINING_DEFAULT_TAKE_PROFIT_PCT || 0.008
);

const DEFAULT_MAX_HOLD_BARS = Number(
  process.env.TRAINING_DEFAULT_MAX_HOLD_BARS || 12
);

const DEFAULT_RISK_PCT = Number(
  process.env.TRAINING_DEFAULT_RISK_PCT || 0.01
);

const DEFAULT_STARTING_CAPITAL = Number(
  process.env.TRAINING_DEFAULT_STARTING_CAPITAL || 10000
);

const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.TRAINING_DEFAULT_CONFIDENCE_THRESHOLD || 0.5
);

const DEFAULT_EDGE_THRESHOLD = Number(
  process.env.TRAINING_DEFAULT_EDGE_THRESHOLD || 0.0001
);

/* =========================================================
UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function round(v, digits = 8) {
  return Number(safeNum(v, 0).toFixed(digits));
}

function normalizeAction(action) {
  const v = String(action || "WAIT").trim().toUpperCase();

  if (["BUY", "SELL", "CLOSE", "WAIT", "HOLD"].includes(v)) {
    return v === "HOLD" ? "WAIT" : v;
  }

  return "WAIT";
}

function candleTime(candle, index) {
  return (
    candle?.time ??
    candle?.ts ??
    candle?.timestamp ??
    candle?.openTime ??
    candle?.closeTime ??
    index
  );
}

function normalizeCandle(candle = {}, index = 0) {
  const open = safeNum(candle.open, safeNum(candle.o, NaN));
  const close = safeNum(candle.close, safeNum(candle.c, open));

  const highRaw = safeNum(
    candle.high,
    safeNum(candle.h, Math.max(open, close))
  );

  const lowRaw = safeNum(
    candle.low,
    safeNum(candle.l, Math.min(open, close))
  );

  const high = Math.max(highRaw, open, close);
  const low = Math.min(lowRaw, open, close);

  return {
    ...candle,
    open,
    high,
    low,
    close,
    time: candleTime(candle, index),
  };
}

function getCandlePrices(candle = {}, index = 0) {
  const normalized = normalizeCandle(candle, index);

  return {
    open: normalized.open,
    high: normalized.high,
    low: normalized.low,
    close: normalized.close,
  };
}

function isUsableCandle(candle = {}, index = 0) {
  const { open, high, low, close } = getCandlePrices(candle, index);

  return (
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    close > 0 &&
    high >= low
  );
}

function getStrategyThresholds(strategy = null) {
  return {
    confidenceThreshold: clamp(
      safeNum(strategy?.confidenceThreshold, DEFAULT_CONFIDENCE_THRESHOLD),
      0,
      1
    ),
    edgeThreshold: Math.max(
      0,
      safeNum(strategy?.edgeThreshold, DEFAULT_EDGE_THRESHOLD)
    ),
    riskMultiplier: clamp(safeNum(strategy?.riskMultiplier, 1), 0.1, 5),
    maxHoldBars: Math.max(
      1,
      Math.floor(safeNum(strategy?.maxHoldBars, DEFAULT_MAX_HOLD_BARS))
    ),
  };
}

function buildStops(side, entry, providedStopLoss, providedTakeProfit) {
  let stopLoss = safeNum(providedStopLoss, NaN);
  let takeProfit = safeNum(providedTakeProfit, NaN);

  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    stopLoss =
      side === "LONG"
        ? entry * (1 - DEFAULT_STOP_LOSS_PCT)
        : entry * (1 + DEFAULT_STOP_LOSS_PCT);
  }

  if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
    takeProfit =
      side === "LONG"
        ? entry * (1 + DEFAULT_TAKE_PROFIT_PCT)
        : entry * (1 - DEFAULT_TAKE_PROFIT_PCT);
  }

  return {
    stopLoss,
    takeProfit,
  };
}

function getPositionSize({
  capital,
  price,
  riskPct,
  confidence,
  riskMultiplier = 1,
}) {
  const usableCapital = safeNum(capital, 0);
  const entry = safeNum(price, 0);

  if (usableCapital <= 0 || entry <= 0) return 0;

  let pct = safeNum(riskPct, DEFAULT_RISK_PCT);
  pct = clamp(pct, 0.001, 0.05);

  const conf = clamp(safeNum(confidence, 0.5), 0, 1);

  let confBoost = 1;
  if (conf >= 0.85) confBoost = 1.2;
  else if (conf >= 0.7) confBoost = 1.05;
  else if (conf < 0.4) confBoost = 0.7;

  const notional =
    usableCapital *
    pct *
    clamp(safeNum(riskMultiplier, 1), 0.1, 5) *
    confBoost;

  if (notional <= 0) return 0;

  return notional / entry;
}

function calcPnl(side, entry, exit, qty) {
  const q = safeNum(qty, 0);
  const e = safeNum(entry, 0);
  const x = safeNum(exit, 0);

  if (q <= 0 || e <= 0 || x <= 0) return 0;

  if (side === "LONG") return (x - e) * q;
  if (side === "SHORT") return (e - x) * q;

  return 0;
}

function emptyStats() {
  return {
    candlesProcessed: 0,
    decisionsSeen: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    grossPnl: 0,
    avgPnl: 0,
    winRate: 0,
    endingCapital: 0,
    startingCapital: 0,
    maxDrawdown: 0,
    bestTrade: 0,
    worstTrade: 0,
  };
}

function buildPaperState({
  symbol,
  capital,
  openPosition,
  close,
}) {
  const activePosition = openPosition
    ? {
        symbol,
        side: openPosition.side,
        entry: openPosition.entry,
        qty: openPosition.qty,
        time: openPosition.openTime,
        stopLoss: openPosition.stopLoss,
        takeProfit: openPosition.takeProfit,
      }
    : null;

  return {
    equity: capital,
    cashBalance: capital,
    availableCapital: capital,
    lockedCapital: 0,
    position: activePosition,
    positions: {
      scalp: activePosition,
      structure: null,
    },
    lastPrice: close,
  };
}

function finalizeStats(stats, endingCapital) {
  const next = {
    ...stats,
    grossPnl: round(stats.grossPnl, 8),
    endingCapital: round(endingCapital, 8),
    startingCapital: round(stats.startingCapital, 8),
    maxDrawdown: round(stats.maxDrawdown, 8),
    bestTrade: round(stats.bestTrade, 8),
    worstTrade: round(stats.worstTrade, 8),
  };

  next.avgPnl =
    next.tradesClosed > 0 ? round(next.grossPnl / next.tradesClosed, 8) : 0;

  next.winRate =
    next.tradesClosed > 0 ? round((next.wins / next.tradesClosed) * 100, 4) : 0;

  return next;
}

/* =========================================================
CORE TRAINING SESSION
========================================================= */

async function runTrainingSession({
  tenantId,
  symbol = "BTCUSDT",
  candles = [],
  strategy = null,
  decisionBuilder = null,
  startingCapital = DEFAULT_STARTING_CAPITAL,
}) {
  const feed = asArray(candles);

  if (!feed.length) {
    return { ok: false, error: "No candles provided" };
  }

  const thresholds = getStrategyThresholds(strategy);
  let capital = safeNum(startingCapital, DEFAULT_STARTING_CAPITAL);

  if (capital <= 0) {
    capital = DEFAULT_STARTING_CAPITAL;
  }

  let peakCapital = capital;
  let openPosition = null;

  const closedTrades = [];
  const decisionLog = [];
  const stats = emptyStats();
  stats.startingCapital = capital;

  for (let i = 0; i < feed.length; i += 1) {
    const candle = feed[i];

    if (!isUsableCandle(candle, i)) {
      continue;
    }

    const normalizedCandle = normalizeCandle(candle, i);
    const { open, high, low, close } = getCandlePrices(normalizedCandle, i);

    stats.candlesProcessed += 1;

    const paperState = buildPaperState({
      symbol,
      capital,
      openPosition,
      close,
    });

    let decision = null;

    try {
      if (typeof decisionBuilder === "function") {
        decision = await decisionBuilder({
          tenantId,
          symbol,
          candle: normalizedCandle,
          index: i,
          paper: paperState,
          strategy,
        });
      } else if (typeof aiBrain.decide === "function") {
        decision = await aiBrain.decide({
          tenantId,
          symbol,
          last: close,
          paper: paperState,
          candle: normalizedCandle,
          strategy,
        });
      }
    } catch {
      decision = null;
    }

    const normalizedDecision = {
      action: normalizeAction(decision?.action),
      confidence: clamp(safeNum(decision?.confidence, 0), 0, 1),
      edge: safeNum(decision?.edge, 0),
      riskPct: clamp(
        safeNum(
          decision?.riskPct,
          thresholds.riskMultiplier * DEFAULT_RISK_PCT
        ),
        0.001,
        0.05
      ),
      stopLoss: safeNum(decision?.stopLoss, NaN),
      takeProfit: safeNum(decision?.takeProfit, NaN),
      time: normalizedCandle.time,
      price: close,
    };

    stats.decisionsSeen += 1;
    decisionLog.push(normalizedDecision);

    /* =========================================
       MANAGE OPEN POSITION FIRST
    ========================================= */

    if (openPosition) {
      let exitReason = null;
      let exitPrice = null;

      if (openPosition.side === "LONG") {
        if (Number.isFinite(low) && low <= openPosition.stopLoss) {
          exitReason = "STOP_LOSS";
          exitPrice = openPosition.stopLoss;
        } else if (Number.isFinite(high) && high >= openPosition.takeProfit) {
          exitReason = "TAKE_PROFIT";
          exitPrice = openPosition.takeProfit;
        }
      }

      if (openPosition.side === "SHORT") {
        if (Number.isFinite(high) && high >= openPosition.stopLoss) {
          exitReason = "STOP_LOSS";
          exitPrice = openPosition.stopLoss;
        } else if (Number.isFinite(low) && low <= openPosition.takeProfit) {
          exitReason = "TAKE_PROFIT";
          exitPrice = openPosition.takeProfit;
        }
      }

      const heldBars = i - openPosition.openIndex;

      if (!exitReason && normalizedDecision.action === "CLOSE") {
        exitReason = "AI_CLOSE";
        exitPrice = close;
      }

      if (!exitReason && heldBars >= thresholds.maxHoldBars) {
        exitReason = "TIME_EXIT";
        exitPrice = close;
      }

      if (exitReason) {
        const pnl = calcPnl(
          openPosition.side,
          openPosition.entry,
          exitPrice,
          openPosition.qty
        );

        capital += pnl;
        peakCapital = Math.max(peakCapital, capital);

        const trade = {
          symbol,
          side: openPosition.side,
          entry: round(openPosition.entry, 8),
          exit: round(exitPrice, 8),
          qty: round(openPosition.qty, 8),
          pnl: round(pnl, 8),
          reason: exitReason,
          openIndex: openPosition.openIndex,
          closeIndex: i,
          durationBars: heldBars,
          openedAt: openPosition.openTime,
          closedAt: normalizedCandle.time,
          stopLoss: round(openPosition.stopLoss, 8),
          takeProfit: round(openPosition.takeProfit, 8),
          strategyId: strategy?.id || null,
        };

        closedTrades.push(trade);
        stats.tradesClosed += 1;
        stats.grossPnl += pnl;
        stats.bestTrade =
          stats.tradesClosed === 1
            ? pnl
            : Math.max(stats.bestTrade, pnl);
        stats.worstTrade =
          stats.tradesClosed === 1
            ? pnl
            : Math.min(stats.worstTrade, pnl);

        if (pnl > 0) stats.wins += 1;
        else if (pnl < 0) stats.losses += 1;
        else stats.breakeven += 1;

        openPosition = null;
      }
    }

    /* =========================================
       OPEN NEW POSITION
    ========================================= */

    if (!openPosition) {
      const canOpenLong =
        normalizedDecision.action === "BUY" &&
        normalizedDecision.confidence >= thresholds.confidenceThreshold &&
        Math.abs(normalizedDecision.edge) >= thresholds.edgeThreshold;

      const canOpenShort =
        normalizedDecision.action === "SELL" &&
        normalizedDecision.confidence >= thresholds.confidenceThreshold &&
        Math.abs(normalizedDecision.edge) >= thresholds.edgeThreshold;

      if (canOpenLong || canOpenShort) {
        const side = canOpenLong ? "LONG" : "SHORT";

        const qty = getPositionSize({
          capital,
          price: close,
          riskPct: normalizedDecision.riskPct,
          confidence: normalizedDecision.confidence,
          riskMultiplier: thresholds.riskMultiplier,
        });

        if (qty > 0) {
          const stops = buildStops(
            side,
            close,
            normalizedDecision.stopLoss,
            normalizedDecision.takeProfit
          );

          openPosition = {
            symbol,
            side,
            entry: close,
            qty,
            stopLoss: stops.stopLoss,
            takeProfit: stops.takeProfit,
            openIndex: i,
            openTime: normalizedCandle.time,
          };

          stats.tradesOpened += 1;
        }
      }
    }

    /* =========================================
       DRAWDOWN TRACKING
    ========================================= */

    peakCapital = Math.max(peakCapital, capital);

    const dd =
      peakCapital > 0 ? (peakCapital - capital) / peakCapital : 0;

    stats.maxDrawdown = Math.max(stats.maxDrawdown, dd);
  }

  /* =========================================
     FORCE CLOSE LAST OPEN POSITION
  ========================================= */

  if (openPosition) {
    const lastIndex = feed.length - 1;
    const lastCandle = normalizeCandle(feed[lastIndex] || {}, lastIndex);
    const lastClose = safeNum(lastCandle.close, openPosition.entry);

    const pnl = calcPnl(
      openPosition.side,
      openPosition.entry,
      lastClose,
      openPosition.qty
    );

    capital += pnl;

    const trade = {
      symbol,
      side: openPosition.side,
      entry: round(openPosition.entry, 8),
      exit: round(lastClose, 8),
      qty: round(openPosition.qty, 8),
      pnl: round(pnl, 8),
      reason: "END_OF_REPLAY",
      openIndex: openPosition.openIndex,
      closeIndex: lastIndex,
      durationBars: lastIndex - openPosition.openIndex,
      openedAt: openPosition.openTime,
      closedAt: lastCandle.time,
      stopLoss: round(openPosition.stopLoss, 8),
      takeProfit: round(openPosition.takeProfit, 8),
      strategyId: strategy?.id || null,
    };

    closedTrades.push(trade);
    stats.tradesClosed += 1;
    stats.grossPnl += pnl;
    stats.bestTrade =
      stats.tradesClosed === 1 ? pnl : Math.max(stats.bestTrade, pnl);
    stats.worstTrade =
      stats.tradesClosed === 1 ? pnl : Math.min(stats.worstTrade, pnl);

    if (pnl > 0) stats.wins += 1;
    else if (pnl < 0) stats.losses += 1;
    else stats.breakeven += 1;
  }

  return {
    ok: true,
    tenantId: tenantId || null,
    symbol: String(symbol || "BTCUSDT").toUpperCase(),
    strategyId: strategy?.id || null,
    stats: finalizeStats(stats, capital),
    closedTrades,
    decisionLog: decisionLog.slice(-500),
  };
}

/* =========================================================
OPTIONAL CONVENIENCE METHOD
========================================================= */

async function runReplayTraining({
  tenantId,
  symbol = "BTCUSDT",
  strategy = null,
  decisionBuilder = null,
}) {
  const candles = await replayEngine.replayCandles({ symbol });

  return runTrainingSession({
    tenantId,
    symbol,
    candles,
    strategy,
    decisionBuilder,
  });
}

module.exports = {
  runTrainingSession,
  runReplayTraining,
};
