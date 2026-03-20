// ==========================================================
// FILE: backend/src/services/strategyLab.js
// VERSION: v2.1 (Maintenance-Safe Strategy Lab)
// PURPOSE
// - Evolve and rank strategy profiles per tenant
// - Keep strategy state inspectable and resettable
// - Safer mutation and evaluation flow
// - Stable helpers for strategyEngine / tradeBrain / admin panels
//
// FIXES
// - Hardened tenant reset flow
// - Safer config normalization
// - Stable seed counts even if env values drift
// - Active strategy list always deduplicated and repaired
// - Parent mutation input normalized
// - Ranking and maintenance helpers made more defensive
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* =========================================================
CONFIG
========================================================= */

const MAX_STRATEGIES = Math.max(
  1,
  Number(process.env.STRATEGY_LAB_MAX_STRATEGIES || 20)
);

const MAX_ACTIVE_STRATEGIES = Math.max(
  1,
  Number(process.env.STRATEGY_LAB_MAX_ACTIVE || 10)
);

const MIN_TRADES_FOR_EVAL = Math.max(
  1,
  Number(process.env.STRATEGY_LAB_MIN_TRADES_FOR_EVAL || 15)
);

const INITIAL_SEED_COUNT = Math.max(
  1,
  Number(process.env.STRATEGY_LAB_INITIAL_SEED_COUNT || 10)
);

const MIN_EDGE_THRESHOLD = Number(
  process.env.STRATEGY_LAB_MIN_EDGE_THRESHOLD || 0.0003
);

const MAX_EDGE_THRESHOLD = Number(
  process.env.STRATEGY_LAB_MAX_EDGE_THRESHOLD || 0.003
);

const MIN_CONFIDENCE_THRESHOLD = Number(
  process.env.STRATEGY_LAB_MIN_CONFIDENCE_THRESHOLD || 0.5
);

const MAX_CONFIDENCE_THRESHOLD = Number(
  process.env.STRATEGY_LAB_MAX_CONFIDENCE_THRESHOLD || 0.85
);

const MIN_RISK_MULTIPLIER = Number(
  process.env.STRATEGY_LAB_MIN_RISK_MULTIPLIER || 0.5
);

const MAX_RISK_MULTIPLIER = Number(
  process.env.STRATEGY_LAB_MAX_RISK_MULTIPLIER || 2
);

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
  const a = safeNum(min, 0);
  const b = safeNum(max, a);
  return Math.random() * (b - a) + a;
}

function uniq(list) {
  return Array.from(new Set(Array.isArray(list) ? list : []));
}

function getStrategyCountLimit() {
  return Math.max(MAX_STRATEGIES, 1);
}

function getActiveCountLimit() {
  return Math.min(
    Math.max(MAX_ACTIVE_STRATEGIES, 1),
    getStrategyCountLimit()
  );
}

function getSeedCount() {
  return Math.min(
    Math.max(INITIAL_SEED_COUNT, 1),
    getStrategyCountLimit()
  );
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

  repairState(key);
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
    Math.min(MIN_EDGE_THRESHOLD, MAX_EDGE_THRESHOLD),
    Math.max(MIN_EDGE_THRESHOLD, MAX_EDGE_THRESHOLD)
  );

  const confidenceThreshold = clamp(
    safeNum(
      overrides.confidenceThreshold,
      randomBetween(0.55, 0.75)
    ),
    Math.min(MIN_CONFIDENCE_THRESHOLD, MAX_CONFIDENCE_THRESHOLD),
    Math.max(MIN_CONFIDENCE_THRESHOLD, MAX_CONFIDENCE_THRESHOLD)
  );

  const riskMultiplier = clamp(
    safeNum(
      overrides.riskMultiplier,
      randomBetween(0.7, 1.8)
    ),
    Math.min(MIN_RISK_MULTIPLIER, MAX_RISK_MULTIPLIER),
    Math.max(MIN_RISK_MULTIPLIER, MAX_RISK_MULTIPLIER)
  );

  return {
    id:
      overrides.id ||
      `S_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,

    label: overrides.label || "evolved-strategy",

    edgeThreshold,
    confidenceThreshold,
    riskMultiplier,

    trades: Math.max(0, safeNum(overrides.trades, 0)),
    wins: Math.max(0, safeNum(overrides.wins, 0)),
    losses: Math.max(0, safeNum(overrides.losses, 0)),
    breakeven: Math.max(0, safeNum(overrides.breakeven, 0)),
    pnl: safeNum(overrides.pnl, 0),

    createdAt: overrides.createdAt || nowIso(),
    updatedAt: overrides.updatedAt || nowIso(),
    lastTradeAt: overrides.lastTradeAt || null,
  };
}

function seedStrategies(tenantId) {
  const key = safeTenantKey(tenantId);
  const state = LAB.get(key);

  if (!state) return;

  const seedCount = getSeedCount();

  for (let i = 0; i < seedCount; i += 1) {
    const strategy = createStrategy({
      id: `S${i}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
      label: `seed-${i + 1}`,
    });

    state.strategies[strategy.id] = strategy;
  }

  state.activeStrategies = Object.keys(state.strategies).slice(
    0,
    getActiveCountLimit()
  );

  state.stats.totalSeeds += seedCount;
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
STATE REPAIR
========================================================= */

function repairState(tenantId) {
  const key = safeTenantKey(tenantId);
  const state = LAB.get(key);

  if (!state) return null;

  state.strategies = state.strategies && typeof state.strategies === "object"
    ? state.strategies
    : {};

  const validIds = new Set(Object.keys(state.strategies));

  state.activeStrategies = uniq(state.activeStrategies)
    .filter((id) => validIds.has(String(id)))
    .map(String)
    .slice(0, getActiveCountLimit());

  if (
    state.activeStrategies.length === 0 &&
    Object.keys(state.strategies).length > 0
  ) {
    state.activeStrategies = Object.keys(state.strategies).slice(
      0,
      getActiveCountLimit()
    );
  }

  state.stats = {
    totalRecordedTrades: safeNum(state?.stats?.totalRecordedTrades, 0),
    totalEvaluations: safeNum(state?.stats?.totalEvaluations, 0),
    totalMutations: safeNum(state?.stats?.totalMutations, 0),
    totalSeeds: safeNum(state?.stats?.totalSeeds, 0),
  };

  state.updatedAt = state.updatedAt || nowIso();

  return state;
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
    .map((id) => state.strategies[String(id)])
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
  const active = getActiveStrategies(tenantId);

  if (!active.length) return null;

  const qualified = active.filter(
    (s) => safeNum(s.trades, 0) >= MIN_TRADES_FOR_EVAL
  );

  const pool = qualified.length ? qualified : active;
  const topHalf = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));

  const picked =
    topHalf[Math.floor(Math.random() * topHalf.length)] ||
    pool[0] ||
    null;

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

  strategy.trades = Math.max(0, safeNum(strategy.trades, 0) + 1);
  strategy.pnl = safeNum(strategy.pnl, 0) + pnl;
  strategy.updatedAt = nowIso();
  strategy.lastTradeAt = nowIso();

  if (pnl > 0) {
    strategy.wins = Math.max(0, safeNum(strategy.wins, 0) + 1);
  } else if (pnl < 0) {
    strategy.losses = Math.max(0, safeNum(strategy.losses, 0) + 1);
  } else {
    strategy.breakeven = Math.max(0, safeNum(strategy.breakeven, 0) + 1);
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
    .slice(0, getActiveCountLimit())
    .map((s) => s.id);

  state.lastEvaluationAt = nowIso();
  state.updatedAt = nowIso();
  state.stats.totalEvaluations += 1;

  if (
    ranked.length > 0 &&
    Object.keys(state.strategies).length < getStrategyCountLimit()
  ) {
    mutateStrategy(tenantId, ranked[0]);
  }

  repairState(tenantId);

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
  const normalizedParent =
    parent && typeof parent === "object"
      ? parent
      : null;

  if (!normalizedParent) {
    return {
      ok: false,
      error: "Parent strategy missing",
    };
  }

  if (Object.keys(state.strategies).length >= getStrategyCountLimit()) {
    return {
      ok: false,
      error: "Max strategies reached",
    };
  }

  const child = createStrategy({
    label: `mutant-from-${normalizedParent.id || "unknown"}`,
    edgeThreshold: clamp(
      safeNum(normalizedParent.edgeThreshold, 0.001) *
        randomBetween(0.9, 1.1),
      Math.min(MIN_EDGE_THRESHOLD, MAX_EDGE_THRESHOLD),
      Math.max(MIN_EDGE_THRESHOLD, MAX_EDGE_THRESHOLD)
    ),
    confidenceThreshold: clamp(
      safeNum(normalizedParent.confidenceThreshold, 0.6) *
        randomBetween(0.9, 1.1),
      Math.min(MIN_CONFIDENCE_THRESHOLD, MAX_CONFIDENCE_THRESHOLD),
      Math.max(MIN_CONFIDENCE_THRESHOLD, MAX_CONFIDENCE_THRESHOLD)
    ),
    riskMultiplier: clamp(
      safeNum(normalizedParent.riskMultiplier, 1) *
        randomBetween(0.9, 1.1),
      Math.min(MIN_RISK_MULTIPLIER, MAX_RISK_MULTIPLIER),
      Math.max(MIN_RISK_MULTIPLIER, MAX_RISK_MULTIPLIER)
    ),
  });

  state.strategies[child.id] = child;
  state.activeStrategies = uniq([...state.activeStrategies, child.id]).slice(
    0,
    getActiveCountLimit()
  );

  state.lastMutationAt = nowIso();
  state.updatedAt = nowIso();
  state.stats.totalMutations += 1;

  repairState(tenantId);

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
  LAB.set(key, createEmptyState());
  seedStrategies(key);
  repairState(key);

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

  const rankedIds = Object.values(state.strategies)
    .map(enrichStrategy)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.id);

  state.activeStrategies = uniq([
    ...state.activeStrategies,
    ...rankedIds,
  ]).slice(0, getActiveCountLimit());

  state.updatedAt = nowIso();

  repairState(tenantId);

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
