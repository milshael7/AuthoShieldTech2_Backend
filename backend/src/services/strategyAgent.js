// ==========================================================
// FILE: backend/src/services/strategyAgent.js
// VERSION: v1.0 (Maintenance-Safe Strategy Agent)
// PURPOSE
// - Bridge strategy discovery, training, and lab selection
// - Give the AI a stable strategy manager layer
// - Provide safe fallbacks if one module is missing or drifts
// - Make strategy evolution inspectable for admin/frontend use
// ==========================================================

const strategyLab = require("./strategyLab");
const strategyDiscovery = require("./strategyDiscovery");
const trainingEngine = require("./trainingEngine");

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

function nowIso() {
  return new Date().toISOString();
}

function normalizeTenantId(tenantId) {
  return String(tenantId || "__default__");
}

/* =========================================================
ACTIVE STRATEGY ACCESS
========================================================= */

function getActiveStrategy(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    const selected = strategyLab.selectStrategy(key);
    return selected || null;
  } catch {
    return null;
  }
}

function getStrategySnapshot(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab.getSnapshot === "function") {
      return strategyLab.getSnapshot(key);
    }
  } catch {}

  return {
    createdAt: nowIso(),
    updatedAt: nowIso(),
    activeStrategies: [],
    strategies: [],
    stats: {
      totalStrategies: 0,
      activeCount: 0,
      totalRecordedTrades: 0,
      totalEvaluations: 0,
      totalMutations: 0,
      totalSeeds: 0,
    },
  };
}

/* =========================================================
DISCOVERY
========================================================= */

async function discover(tenantId, options = {}) {
  const key = normalizeTenantId(tenantId);

  if (typeof strategyDiscovery?.discoverStrategy !== "function") {
    return {
      ok: false,
      error: "Strategy discovery engine unavailable",
    };
  }

  try {
    const result = await strategyDiscovery.discoverStrategy({
      tenantId: key,
      symbol: options.symbol || "BTCUSDT",
      variants: options.variants,
    });

    return {
      ok: true,
      discoveredAt: nowIso(),
      result,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Strategy discovery failed",
    };
  }
}

/* =========================================================
TRAINING
========================================================= */

async function train(tenantId, options = {}) {
  const key = normalizeTenantId(tenantId);

  if (typeof trainingEngine?.runReplayTraining !== "function") {
    return {
      ok: false,
      error: "Training engine unavailable",
    };
  }

  try {
    const result = await trainingEngine.runReplayTraining({
      tenantId: key,
      symbol: options.symbol || "BTCUSDT",
      strategy: options.strategy || getActiveStrategy(key),
      decisionBuilder: options.decisionBuilder || null,
    });

    return {
      ok: true,
      trainedAt: nowIso(),
      result,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Strategy training failed",
    };
  }
}

/* =========================================================
LEARNING FEEDBACK
========================================================= */

function recordTradeResult({
  tenantId,
  strategyId,
  profit,
}) {
  const key = normalizeTenantId(tenantId);

  try {
    let resolvedStrategyId = strategyId;

    if (!resolvedStrategyId) {
      const active = getActiveStrategy(key);
      resolvedStrategyId = active?.id || null;
    }

    if (!resolvedStrategyId) {
      return {
        ok: false,
        error: "No active strategy available",
      };
    }

    if (typeof strategyLab.recordTrade !== "function") {
      return {
        ok: false,
        error: "Strategy lab recordTrade unavailable",
      };
    }

    return strategyLab.recordTrade({
      tenantId: key,
      strategyId: resolvedStrategyId,
      profit: safeNum(profit, 0),
    });
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Failed to record trade result",
    };
  }
}

/* =========================================================
EVALUATION / MUTATION
========================================================= */

function evaluate(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab.evaluateStrategies !== "function") {
      return {
        ok: false,
        error: "Strategy lab evaluation unavailable",
      };
    }

    return strategyLab.evaluateStrategies(key);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Strategy evaluation failed",
    };
  }
}

function mutate(tenantId, parentStrategy = null) {
  const key = normalizeTenantId(tenantId);

  try {
    const parent =
      parentStrategy ||
      getActiveStrategy(key) ||
      asArray(strategyLab.listStrategies?.(key))[0] ||
      null;

    if (!parent) {
      return {
        ok: false,
        error: "No parent strategy available",
      };
    }

    if (typeof strategyLab.mutateStrategy !== "function") {
      return {
        ok: false,
        error: "Strategy lab mutation unavailable",
      };
    }

    return strategyLab.mutateStrategy(key, parent);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Strategy mutation failed",
    };
  }
}

/* =========================================================
RESET
========================================================= */

function reset(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab.resetTenant !== "function") {
      return {
        ok: false,
        error: "Strategy lab reset unavailable",
      };
    }

    return strategyLab.resetTenant(key);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Strategy reset failed",
    };
  }
}

/* =========================================================
ADMIN HELPERS
========================================================= */

function list(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab.listStrategies === "function") {
      return strategyLab.listStrategies(key);
    }
  } catch {}

  return [];
}

function getStatus(tenantId) {
  const key = normalizeTenantId(tenantId);
  const snapshot = getStrategySnapshot(key);
  const active = getActiveStrategy(key);

  return {
    ok: true,
    tenantId: key,
    activeStrategy: active,
    totalStrategies: safeNum(snapshot?.stats?.totalStrategies, 0),
    activeCount: safeNum(snapshot?.stats?.activeCount, 0),
    snapshot,
    time: nowIso(),
  };
}

/* =========================================================
EXPORTS
========================================================= */

module.exports = {
  getActiveStrategy,
  getStrategySnapshot,
  discover,
  train,
  recordTradeResult,
  evaluate,
  mutate,
  reset,
  list,
  getStatus,
};
