// ==========================================================
// FILE: backend/src/services/strategyLab.js
// VERSION: v2.0 (Maintenance-Safe Strategy Lab)
// PURPOSE
// - Evolve and rank strategy profiles per tenant
// - Keep strategy state inspectable and resettable
// - Safer mutation and evaluation flow
// - Stable helpers for strategyEngine / tradeBrain / admin panels
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const MAX_STRATEGIES =
  Number(process.env.STRATEGY_LAB_MAX_STRATEGIES || 20);

const MAX_ACTIVE_STRATEGIES =
  Number(process.env.STRATEGY_LAB_MAX_ACTIVE || 10);

const MIN_TRADES_FOR_EVAL =
  Number(process.env.STRATEGY_LAB_MIN_TRADES_FOR_EVAL || 15);

const INITIAL_SEED_COUNT =
  Number(process.env.STRATEGY_LAB_INITIAL_SEED_COUNT || 10);

const MIN_EDGE_THRESHOLD =
  Number(process.env.STRATEGY_LAB_MIN_EDGE_THRESHOLD || 0.0003);

const MAX_EDGE_THRESHOLD =
  Number(process.env.STRATEGY_LAB_MAX_EDGE_THRESHOLD || 0.003);

const MIN_CONFIDENCE_THRESHOLD =
  Number(process.env.STRATEGY_LAB_MIN_CONFIDENCE_THRESHOLD || 0.5);

const MAX_CONFIDENCE_THRESHOLD =
  Number(process.env.STRATEGY_LAB_MAX_CONFIDENCE_THRESHOLD || 0.85);

const MIN_RISK_MULTIPLIER =
  Number(process.env.STRATEGY_LAB_MIN_RISK_MULTIPLIER || 0.5);

const MAX_RISK_MULTIPLIER =
  Number(process.env.STRATEGY_LAB_MAX_RISK_MULTIPLIER || 2);

/* =========================================================
STATE
========================================================= */

const LAB = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeTenantKey(tenantId) {
  return String(tenantId || "__default__");
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function createEmptyState() {
  return {
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastEvaluationAt: null,
    lastMutationAt: null,
    strategies: {},
    activeStrategies: [],
    stats: {
      totalRecordedTrades: 0,
      totalEvaluations: 0,
      totalMutations: 0,
      totalSeeds: 0,
    },
  };
}

function getState(tenantId) {
  const key = safeTenantKey(tenantId);

  if (!LAB.has(key)) {
    LAB.set(key, createEmptyState());
    seedStrategies(key);
  }

  return LAB.get(key);
}

/* =========================================================
STRATEGY CREATION
========================================================= */

function createStrategy(overrides = {}) {
  const edgeThreshold = clamp(
    safeNum(
      overrides.edgeThreshold,
      randomBetween(0.0005, 0.0025)
    ),
    MIN_EDGE_THRESHOLD,
    MAX_EDGE_THRESHOLD
  );

  const confidenceThreshold = clamp(
    safeNum(
      overrides.confidenceThreshold,
      randomBetween(0.55, 0.75)
    ),
    MIN_CONFIDENCE_THRESHOLD,
    MAX_CONFIDENCE_THRESHOLD
  );

  const riskMultiplier = clamp(
    safeNum(
      overrides.riskMultiplier,
      randomBetween(0.7, 1.8)
    ),
    MIN_RISK_MULTIPLIER,
    MAX_RISK_MULTIPLIER
  );

  return {
    id:
      overrides.id ||
      `S_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,

    label: overrides.label || "evolved-strategy",

    edgeThreshold,
    confidenceThreshold,
    riskMultiplier,

    trades: safeNum(overrides.trades, 0),
    wins: safeNum(overrides.wins, 0),
    losses: safeNum(overrides.losses, 0),
    breakeven: safeNum(overrides.breakeven, 0),
    pnl: safeNum(overrides.pnl, 0),

    createdAt: overrides.createdAt || nowIso(),
    updatedAt: overrides.updatedAt || nowIso(),
    lastTradeAt: overrides.lastTradeAt || null,
  };
}

function seedStrategies(tenantId) {
  const state = LAB.get(safeTenantKey(tenantId));
  if (!state) return;

  for (let i = 0; i < INITIAL_SEED_COUNT; i += 1) {
    const strategy = createStrategy({
      id: `S${i}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
      label: `seed-${i + 1}`,
    });

    state.strategies[strategy.id] = strategy;

    if (state.activeStrategies.length < MAX_ACTIVE_STRATEGIES) {
      state.activeStrategies.push(strategy.id);
    }
  }

  state.stats.totalSeeds += INITIAL_SEED_COUNT;
  state.updatedAt = nowIso();
}

/* =========================================================
METRICS
========================================================= */

function getWinRate(strategy) {
  const trades = safeNum(strategy?.trades, 0);
  if (trades <= 0) return 0;
  return safeNum(strategy?.wins, 0) / trades;
}

function getAvgPnl(strategy) {
  const trades = safeNum(strategy?.trades, 0);
  if (trades <= 0) return 0;
  return safeNum(strategy?.pnl, 0) / trades;
}

function getScore(strategy) {
  const trades = safeNum(strategy?.trades, 0);
  const pnl = safeNum(strategy?.pnl, 0);
  const winRate = getWinRate(strategy);
  const avgPnl = getAvgPnl(strategy);

  const sampleQuality =
    trades >= MIN_TRADES_FOR_EVAL
      ? 1
      : trades / Math.max(MIN_TRADES_FOR_EVAL, 1);

  return (
    pnl * 0.55 +
    winRate * 100 * 0.2 +
    avgPnl * 10 * 0.15 +
    sampleQuality * 10 * 0.1
  );
}

function enrichStrategy(strategy) {
  return {
    ...strategy,
    winRate: getWinRate(strategy),
    avgPnl: getAvgPnl(strategy),
    score: getScore(strategy),
  };
}

/* =========================================================
READ HELPERS
========================================================= */

function getStrategy(tenantId, strategyId) {
  const state = getState(tenantId);
  return state.strategies[String(strategyId)] || null;
}

function listStrategies(tenantId) {
  const state = getState(tenantId);

  return Object.values(state.strategies)
    .map(enrichStrategy)
    .sort((a, b) => b.score - a.score);
}

function getActiveStrategies(tenantId) {
  const state = getState(tenantId);

  return state.activeStrategies
    .map((id) => state.strategies[id])
    .filter(Boolean)
    .map(enrichStrategy)
    .sort((a, b) => b.score - a.score);
}

function getSnapshot(tenantId) {
  const state = getState(tenantId);

  return {
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastEvaluationAt: state.lastEvaluationAt,
    lastMutationAt: state.lastMutationAt,
    activeStrategies: getActiveStrategies(tenantId),
    strategies: listStrategies(tenantId),
    stats: {
      ...state.stats,
      totalStrategies: Object.keys(state.strategies).length,
      activeCount: state.activeStrategies.length,
    },
  };
}

/* =========================================================
SELECTION
========================================================= */

function selectStrategy(tenantId) {
  const state = getState(tenantId);
  const active = getActiveStrategies(tenantId);

  if (!active.length) return null;

  const qualified = active.filter(
    (s) => safeNum(s.trades, 0) >= MIN_TRADES_FOR_EVAL
  );

  const pool = qualified.length ? qualified : active;
  const topHalf = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));

  const picked =
    topHalf[Math.floor(Math.random() * topHalf.length)] || pool[0] || null;

  return picked ? { ...picked } : null;
}

/* =========================================================
RECORD TRADE
========================================================= */

function recordTrade({
  tenantId,
  strategyId,
  profit,
}) {
  const state = getState(tenantId);
  const strategy = state.strategies[String(strategyId)];

  if (!strategy) {
    return {
      ok: false,
      error: "Strategy not found",
    };
  }

  const pnl = safeNum(profit, 0);

  strategy.trades += 1;
  strategy.pnl += pnl;
  strategy.updatedAt = nowIso();
  strategy.lastTradeAt = nowIso();

  if (pnl > 0) {
    strategy.wins += 1;
  } else if (pnl < 0) {
    strategy.losses += 1;
  } else {
    strategy.breakeven += 1;
  }

  state.stats.totalRecordedTrades += 1;
  state.updatedAt = nowIso();

  if (strategy.trades >= MIN_TRADES_FOR_EVAL) {
    evaluateStrategies(tenantId);
  }

  return {
    ok: true,
    strategy: enrichStrategy(strategy),
  };
}

/* =========================================================
EVALUATION
========================================================= */

function evaluateStrategies(tenantId) {
  const state = getState(tenantId);

  const ranked = Object.values(state.strategies)
    .map(enrichStrategy)
    .sort((a, b) => b.score - a.score);

  state.activeStrategies = ranked
    .slice(0, MAX_ACTIVE_STRATEGIES)
    .map((s) => s.id);

  state.lastEvaluationAt = nowIso();
  state.updatedAt = nowIso();
  state.stats.totalEvaluations += 1;

  if (
    ranked.length > 0 &&
    Object.keys(state.strategies).length < MAX_STRATEGIES
  ) {
    mutateStrategy(tenantId, ranked[0]);
  }

  return {
    ok: true,
    activeStrategies: getActiveStrategies(tenantId),
  };
}

/* =========================================================
MUTATION
========================================================= */

function mutateStrategy(tenantId, parent) {
  const state = getState(tenantId);

  if (!parent) {
    return {
      ok: false,
      error: "Parent strategy missing",
    };
  }

  if (Object.keys(state.strategies).length >= MAX_STRATEGIES) {
    return {
      ok: false,
      error: "Max strategies reached",
    };
  }

  const child = createStrategy({
    label: `mutant-from-${parent.id}`,
    edgeThreshold: clamp(
      safeNum(parent.edgeThreshold, 0.001) * randomBetween(0.9, 1.1),
      MIN_EDGE_THRESHOLD,
      MAX_EDGE_THRESHOLD
    ),
    confidenceThreshold: clamp(
      safeNum(parent.confidenceThreshold, 0.6) * randomBetween(0.9, 1.1),
      MIN_CONFIDENCE_THRESHOLD,
      MAX_CONFIDENCE_THRESHOLD
    ),
    riskMultiplier: clamp(
      safeNum(parent.riskMultiplier, 1) * randomBetween(0.9, 1.1),
      MIN_RISK_MULTIPLIER,
      MAX_RISK_MULTIPLIER
    ),
  });

  state.strategies[child.id] = child;

  if (!state.activeStrategies.includes(child.id)) {
    state.activeStrategies.push(child.id);
  }

  state.activeStrategies = Array.from(new Set(state.activeStrategies)).slice(
    0,
    MAX_ACTIVE_STRATEGIES
  );

  state.lastMutationAt = nowIso();
  state.updatedAt = nowIso();
  state.stats.totalMutations += 1;

  return {
    ok: true,
    strategy: enrichStrategy(child),
  };
}

/* =========================================================
MAINTENANCE
========================================================= */

function resetTenant(tenantId) {
  const key = safeTenantKey(tenantId);
  LAB.delete(key);
  getState(key);

  return {
    ok: true,
    snapshot: getSnapshot(key),
  };
}

function removeStrategy(tenantId, strategyId) {
  const state = getState(tenantId);
  const id = String(strategyId);

  if (!state.strategies[id]) {
    return {
      ok: false,
      error: "Strategy not found",
    };
  }

  delete state.strategies[id];
  state.activeStrategies = state.activeStrategies.filter((x) => x !== id);

  if (
    state.activeStrategies.length < Math.min(MAX_ACTIVE_STRATEGIES, Object.keys(state.strategies).length)
  ) {
    const refill = Object.values(state.strategies)
      .map(enrichStrategy)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.id);

    state.activeStrategies = Array.from(
      new Set([...state.activeStrategies, ...refill])
    ).slice(0, MAX_ACTIVE_STRATEGIES);
  }

  state.updatedAt = nowIso();

  return {
    ok: true,
    snapshot: getSnapshot(tenantId),
  };
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  getState,
  getSnapshot,
  getStrategy,
  listStrategies,
  getActiveStrategies,
  selectStrategy,
  recordTrade,
  evaluateStrategies,
  mutateStrategy,
  removeStrategy,
  resetTenant,
};
