// backend/src/services/paperTrader.js
// Phase 6 — Institutional Paper Engine
// Strategy → Risk → Portfolio → Execution
// Fully Adaptive • Multi-Layer Protected • Tenant Safe

const fs = require("fs");
const path = require("path");

const { makeDecision } = require("./tradeBrain");
const riskManager = require("./riskManager");
const portfolioManager = require("./portfolioManager");

const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200);
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);

const BASE_PATH =
  process.env.PAPER_STATE_DIR || path.join("/tmp", "paper_trader");

/* ================= HELPERS ================= */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function statePath(tenantId) {
  ensureDir(BASE_PATH);
  return path.join(BASE_PATH, `paper_${tenantId}.json`);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function narrate(tenantId, text, meta = {}) {
  if (!text) return;
  addMemory({
    tenantId,
    type: "trade_event",
    text: String(text).slice(0, 800),
    meta,
  });
}

/* ================= STATE ================= */

function defaultState() {
  return {
    running: true,

    cashBalance: START_BAL,
    equity: START_BAL,
    peakEquity: START_BAL,

    realized: {
      wins: 0,
      losses: 0,
      net: 0,
      grossProfit: 0,
      grossLoss: 0,
    },

    costs: {
      feePaid: 0,
    },

    position: null,
    trades: [],

    lastPrice: null,
    volatility: 0.002,

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      lastReason: "boot",
      trendEdge: 0,
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lossesToday: 0,
      halted: false,
      haltReason: null,
      cooling: false,
    },
  };
}

const STATES = new Map();

/* ================= PERSIST ================= */

function load(tenantId) {
  if (STATES.has(tenantId)) return STATES.get(tenantId);

  let state = defaultState();
  const file = statePath(tenantId);

  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      state = { ...state, ...raw };
    }
  } catch {}

  STATES.set(tenantId, state);
  return state;
}

function save(tenantId) {
  const state = STATES.get(tenantId);
  if (!state) return;

  try {
    fs.writeFileSync(
      statePath(tenantId),
      JSON.stringify(state, null, 2)
    );
  } catch {}
}

/* ================= CORE ================= */

function updateVolatility(state, price) {
  if (!state.lastPrice) {
    state.lastPrice = price;
    return;
  }

  const change = Math.abs(price - state.lastPrice) / state.lastPrice;

  state.volatility = clamp(
    state.volatility * 0.9 + change * 0.1,
    0.0001,
    0.05
  );

  state.lastPrice = price;
}

function updateEquity(state, price) {
  if (state.position) {
    state.equity =
      state.cashBalance +
      (price - state.position.entry) * state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }

  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function resetDaily(state, ts) {
  const dk = dayKey(ts);
  if (dk !== state.limits.dayKey) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
  }
}

/* ================= EXECUTION ================= */

function openPosition(state, tenantId, symbol, price, riskPct) {
  const usd = clamp(
    state.cashBalance * riskPct,
    50,
    state.cashBalance * 0.5
  );

  if (usd <= 0) return;

  const qty = usd / price;
  const fee = usd * FEE_RATE;

  state.cashBalance -= usd + fee;
  state.costs.feePaid += fee;

  state.position = {
    symbol,
    entry: price,
    qty,
    ts: Date.now(),
  };

  state.limits.tradesToday++;

  narrate(tenantId, `Entered ${symbol} at ${price}`, {
    action: "BUY",
    usd,
  });
}

function closePosition(state, tenantId, price, reason) {
  const pos = state.position;
  if (!pos) return;

  const gross = (price - pos.entry) * pos.qty;
  const fee = Math.abs(gross) * FEE_RATE;
  const pnl = gross - fee;

  state.cashBalance += pos.qty * price - fee;
  state.costs.feePaid += fee;
  state.realized.net += pnl;

  if (pnl > 0) {
    state.realized.wins++;
    state.realized.grossProfit += pnl;
  } else {
    state.realized.losses++;
    state.realized.grossLoss += Math.abs(pnl);
    state.limits.lossesToday++;
  }

  state.trades.push({
    time: Date.now(),
    symbol: pos.symbol,
    type: "CLOSE",
    profit: pnl,
    exitReason: reason,
  });

  state.position = null;

  narrate(
    tenantId,
    `Closed ${pos.symbol}. ${pnl >= 0 ? "Profit" : "Loss"} ${pnl.toFixed(2)}`,
    { action: "CLOSE", pnl }
  );
}

/* ================= TICK ================= */

function tick(tenantId, symbol, price, ts = Date.now()) {
  const state = load(tenantId);
  if (!state.running) return;

  resetDaily(state, ts);

  state.learnStats.ticksSeen++;
  updateVolatility(state, price);
  updateEquity(state, price);

  /* ========= 1️⃣ GLOBAL RISK LAYER ========= */

  const risk = riskManager.evaluate({
    tenantId,
    equity: state.equity,
    volatility: state.volatility,
    trades: state.trades,
    ts,
  });

  state.limits.halted = risk.halted;
  state.limits.haltReason = risk.haltReason || null;
  state.limits.cooling = risk.cooling;

  if (risk.halted || risk.cooling) {
    save(tenantId);
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    save(tenantId);
    return;
  }

  /* ========= 2️⃣ STRATEGY DECISION ========= */

  const plan = makeDecision({
    tenantId,
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.trendEdge = plan.edge;
  state.learnStats.lastReason = plan.reason;

  if (plan.action !== "BUY" || state.position) {
    if (
      (plan.action === "SELL" || plan.action === "CLOSE") &&
      state.position
    ) {
      closePosition(state, tenantId, price, plan.reason);
    }

    save(tenantId);
    return;
  }

  /* ========= 3️⃣ PORTFOLIO LAYER ========= */

  const portfolioCheck = portfolioManager.evaluate({
    tenantId,
    symbol,
    equity: state.equity,
    proposedRiskPct: plan.riskPct,
    paperState: state,
  });

  if (!portfolioCheck.allow) {
    narrate(tenantId, `Trade blocked: ${portfolioCheck.reason}`, {
      action: "BLOCKED",
    });
    save(tenantId);
    return;
  }

  /* ========= 4️⃣ FINAL EXECUTION ========= */

  const adjustedRisk = clamp(
    portfolioCheck.adjustedRiskPct *
      (risk.riskMultiplier || 1),
    0.001,
    0.05
  );

  openPosition(state, tenantId, symbol, price, adjustedRisk);

  save(tenantId);
}

/* ================= API ================= */

function snapshot(tenantId) {
  const state = load(tenantId);
  return {
    ...state,
    unrealizedPnL: state.position
      ? (state.lastPrice - state.position.entry) *
        state.position.qty
      : 0,
  };
}

function start() {}

function hardReset(tenantId) {
  STATES.set(tenantId, defaultState());
  save(tenantId);

  riskManager.resetTenant(tenantId);
  portfolioManager.resetTenant(tenantId);
}

module.exports = {
  tick,
  snapshot,
  start,
  hardReset,
};
