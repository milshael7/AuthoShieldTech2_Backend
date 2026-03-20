// ==========================================================
// FILE: backend/src/services/strategyAgent.js
// VERSION: v2.0 (Maintenance-Safe Strategy Agent)
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

function normalizeResult(ok, payload = {}, fallbackError = "Unknown error") {
  if (ok) {
    return {
      ok: true,
      ...payload,
    };
  }

  return {
    ok: false,
    error: payload?.error || fallbackError,
    ...payload,
  };
}

/* =========================================================
ACTIVE STRATEGY ACCESS
========================================================= */

function getActiveStrategy(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab?.selectStrategy !== "function") {
      return null;
    }

    const selected = strategyLab.selectStrategy(key);
    return selected || null;
  } catch {
    return null;
  }
}

function getStrategySnapshot(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab?.getSnapshot === "function") {
      const snapshot = strategyLab.getSnapshot(key);

      if (snapshot && typeof snapshot === "object") {
        return snapshot;
      }
    }
  } catch {}

  return {
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastEvaluationAt: null,
    lastMutationAt: null,
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
    return normalizeResult(false, {
      error: "Strategy discovery engine unavailable",
      tenantId: key,
      time: nowIso(),
    });
  }

  try {
    const result = await strategyDiscovery.discoverStrategy({
      tenantId: key,
      symbol: options.symbol || "BTCUSDT",
      variants: options.variants,
    });

    return normalizeResult(true, {
      tenantId: key,
      discoveredAt: nowIso(),
      result: result || null,
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Strategy discovery failed",
      tenantId: key,
      time: nowIso(),
    });
  }
}

/* =========================================================
TRAINING
========================================================= */

async function train(tenantId, options = {}) {
  const key = normalizeTenantId(tenantId);

  if (typeof trainingEngine?.runReplayTraining !== "function") {
    return normalizeResult(false, {
      error: "Training engine unavailable",
      tenantId: key,
      time: nowIso(),
    });
  }

  try {
    const result = await trainingEngine.runReplayTraining({
      tenantId: key,
      symbol: options.symbol || "BTCUSDT",
      strategy: options.strategy || getActiveStrategy(key),
      decisionBuilder:
        typeof options.decisionBuilder === "function"
          ? options.decisionBuilder
          : null,
    });

    return normalizeResult(true, {
      tenantId: key,
      trainedAt: nowIso(),
      result: result || null,
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Strategy training failed",
      tenantId: key,
      time: nowIso(),
    });
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
      return normalizeResult(false, {
        error: "No active strategy available",
        tenantId: key,
        time: nowIso(),
      });
    }

    if (typeof strategyLab?.recordTrade !== "function") {
      return normalizeResult(false, {
        error: "Strategy lab recordTrade unavailable",
        tenantId: key,
        strategyId: resolvedStrategyId,
        time: nowIso(),
      });
    }

    const result = strategyLab.recordTrade({
      tenantId: key,
      strategyId: resolvedStrategyId,
      profit: safeNum(profit, 0),
    });

    if (result?.ok) {
      return normalizeResult(true, {
        tenantId: key,
        strategyId: resolvedStrategyId,
        ...result,
        time: nowIso(),
      });
    }

    return normalizeResult(false, {
      tenantId: key,
      strategyId: resolvedStrategyId,
      ...(result || {}),
      time: nowIso(),
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Failed to record trade result",
      tenantId: key,
      strategyId: strategyId || null,
      time: nowIso(),
    });
  }
}

/* =========================================================
EVALUATION / MUTATION
========================================================= */

function evaluate(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab?.evaluateStrategies !== "function") {
      return normalizeResult(false, {
        error: "Strategy lab evaluation unavailable",
        tenantId: key,
        time: nowIso(),
      });
    }

    const result = strategyLab.evaluateStrategies(key);

    if (result?.ok) {
      return normalizeResult(true, {
        tenantId: key,
        ...result,
        time: nowIso(),
      });
    }

    return normalizeResult(false, {
      tenantId: key,
      ...(result || {}),
      time: nowIso(),
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Strategy evaluation failed",
      tenantId: key,
      time: nowIso(),
    });
  }
}

function mutate(tenantId, parentStrategy = null) {
  const key = normalizeTenantId(tenantId);

  try {
    const parent =
      parentStrategy ||
      getActiveStrategy(key) ||
      asArray(
        typeof strategyLab?.listStrategies === "function"
          ? strategyLab.listStrategies(key)
          : []
      )[0] ||
      null;

    if (!parent) {
      return normalizeResult(false, {
        error: "No parent strategy available",
        tenantId: key,
        time: nowIso(),
      });
    }

    if (typeof strategyLab?.mutateStrategy !== "function") {
      return normalizeResult(false, {
        error: "Strategy lab mutation unavailable",
        tenantId: key,
        parentStrategyId: parent?.id || null,
        time: nowIso(),
      });
    }

    const result = strategyLab.mutateStrategy(key, parent);

    if (result?.ok) {
      return normalizeResult(true, {
        tenantId: key,
        parentStrategyId: parent?.id || null,
        ...result,
        time: nowIso(),
      });
    }

    return normalizeResult(false, {
      tenantId: key,
      parentStrategyId: parent?.id || null,
      ...(result || {}),
      time: nowIso(),
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Strategy mutation failed",
      tenantId: key,
      time: nowIso(),
    });
  }
}

/* =========================================================
RESET
========================================================= */

function reset(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab?.resetTenant !== "function") {
      return normalizeResult(false, {
        error: "Strategy lab reset unavailable",
        tenantId: key,
        time: nowIso(),
      });
    }

    const result = strategyLab.resetTenant(key);

    if (result?.ok) {
      return normalizeResult(true, {
        tenantId: key,
        ...result,
        time: nowIso(),
      });
    }

    return normalizeResult(false, {
      tenantId: key,
      ...(result || {}),
      time: nowIso(),
    });
  } catch (err) {
    return normalizeResult(false, {
      error: err?.message || "Strategy reset failed",
      tenantId: key,
      time: nowIso(),
    });
  }
}

/* =========================================================
ADMIN HELPERS
========================================================= */

function list(tenantId) {
  const key = normalizeTenantId(tenantId);

  try {
    if (typeof strategyLab?.listStrategies === "function") {
      return asArray(strategyLab.listStrategies(key));
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
