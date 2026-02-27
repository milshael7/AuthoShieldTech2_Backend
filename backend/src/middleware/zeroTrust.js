// backend/src/middleware/zeroTrust.js
// AutoShield Tech — Enterprise Zero Trust Engine v6
// Adaptive • Explainable • Privilege-Sensitive • AI Decision Logged • Stable

const crypto = require("crypto");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const { calculateRisk } = require("../lib/riskEngine");
const { evaluateThreat } = require("../lib/threatIntel");
const { geoLookup, extractIp } = require("../lib/geoLookup");
const sessionAdapter = require("../lib/sessionAdapter");

/* ========================================================= */

const ZERO_TRUST_STRICT = process.env.ZERO_TRUST_STRICT === "true";
const ZERO_TRUST_ENABLED = process.env.ZERO_TRUST_ENABLED !== "false";
const MAX_SECURITY_EVENTS = 2000;
const MAX_AI_DECISIONS = 3000;

const evaluationCache = new Map();
const EVAL_COOLDOWN_MS = 5000;

/* ========================================================= */

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function deriveLevel(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 35) return "Medium";
  return "Low";
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function shouldBypass(req) {
  const path = req.originalUrl || "";
  return (
    path.startsWith("/health") ||
    path.startsWith("/live") ||
    path.startsWith("/ready") ||
    path.startsWith("/api/auth") ||
    path.startsWith("/api/stripe/webhook")
  );
}

/* ========================================================= */

async function zeroTrust(req, res, next) {
  try {
    if (!ZERO_TRUST_ENABLED) return next();
    if (!req.user) return next();
    if (shouldBypass(req)) return next();

    const db = readDb();
    const user = (db.users || []).find(u => u.id === req.user.id);
    if (!user) return next();

    const now = Date.now();

    /* ===== RATE DAMPENING ===== */

    const lastEval = evaluationCache.get(user.id);
    if (lastEval && now - lastEval < EVAL_COOLDOWN_MS) {
      return next();
    }
    evaluationCache.set(user.id, now);

    /* ===== GEO ===== */

    const ip = extractIp(req);
    let geo = null;
    if (ip) geo = await geoLookup(ip);

    /* ===== THREAT ===== */

    const threat = evaluateThreat({
      ip,
      userAgent: req.headers["user-agent"],
      fingerprint: user.activeDeviceFingerprint,
      previousFingerprint: user.activeDeviceFingerprint,
      failedLogins: user.securityFlags?.failedLogins || 0
    });

    /* ===== RISK ===== */

    const risk = calculateRisk({
      geo,
      device: {
        userAgent: req.headers["user-agent"],
        language: req.headers["accept-language"]
      },
      session: {
        activeSessions: sessionAdapter.getActiveSessionCount(user.id)
      },
      behavior: {
        failedLogins: user.securityFlags?.failedLogins || 0
      }
    });

    /* ===== PRIVILEGE WEIGHT ===== */

    const isHighPrivilege =
      req.user.role === "admin" ||
      req.user.role === "finance";

    const privilegeMultiplier = isHighPrivilege ? 1.15 : 1;

    const combinedScore = clamp(
      Math.round(
        ((threat.threatScore * 0.6) +
          (risk.riskScore * 0.4)) * privilegeMultiplier
      ),
      0,
      100
    );

    const level = deriveLevel(combinedScore);

    req.zeroTrust = {
      combinedScore,
      level,
      threatScore: threat.threatScore,
      riskScore: risk.riskScore
    };

    /* ===== AI DECISION MEMORY ===== */

    updateDb(dbState => {

      dbState.brain = dbState.brain || {};
      dbState.brain.decisions = dbState.brain.decisions || [];

      dbState.brain.decisions.push({
        id: `ai_${uid()}`,
        timestamp: new Date().toISOString(),
        userId: user.id,
        role: user.role,
        companyId: req.companyId || user.companyId || null,
        path: req.originalUrl,
        method: req.method,
        ip,
        geo,
        combinedScore,
        level,
        privilegeMultiplier,
        breakdown: {
          threat: threat.breakdown,
          risk: risk.breakdown
        },
        signals: [
          ...(threat.signals || []),
          ...(risk.signals || [])
        ]
      });

      if (dbState.brain.decisions.length > MAX_AI_DECISIONS) {
        dbState.brain.decisions =
          dbState.brain.decisions.slice(-MAX_AI_DECISIONS);
      }

      return dbState;
    });

    /* ===== LOW RISK FAST EXIT ===== */

    if (level === "Low") {
      return next();
    }

    /* ===== AUDIT ===== */

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ZERO_TRUST_EVALUATION",
      detail: {
        combinedScore,
        level,
        path: req.originalUrl,
        method: req.method
      }
    });

    /* ===== SECURITY EVENT ===== */

    updateDb(dbState => {
      dbState.securityEvents = dbState.securityEvents || [];

      dbState.securityEvents.push({
        id: `zt_${uid()}`,
        title: "Zero Trust Risk Evaluation",
        description: `Level: ${level}`,
        severity:
          level === "Critical"
            ? "critical"
            : level === "High"
            ? "high"
            : "medium",
        companyId: req.companyId || user.companyId || null,
        userId: user.id,
        createdAt: new Date().toISOString()
      });

      if (dbState.securityEvents.length > MAX_SECURITY_EVENTS) {
        dbState.securityEvents =
          dbState.securityEvents.slice(-MAX_SECURITY_EVENTS);
      }

      return dbState;
    });

    /* ===== STRICT MODE ===== */

    if (ZERO_TRUST_STRICT && (level === "Critical" || level === "High")) {

      sessionAdapter.revokeAllUserSessions(user.id);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ZERO_TRUST_SESSION_TERMINATED",
        detail: { combinedScore, level }
      });

      return res.status(403).json({
        ok: false,
        error: "Security verification failed"
      });
    }

    return next();

  } catch {

    writeAudit({
      actor: req.user?.id || "unknown",
      role: req.user?.role || "unknown",
      action: "ZERO_TRUST_ERROR",
    });

    return next();
  }
}

module.exports = zeroTrust;
