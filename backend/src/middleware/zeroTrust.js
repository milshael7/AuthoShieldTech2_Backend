// backend/src/middleware/zeroTrust.js
// AutoShield Tech — Enterprise Zero Trust Engine v10
// Stable • Admin Safe • Development Friendly

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

    const user = (db.users || []).find(
      u => u.id === req.user.id
    );

    if (!user) return next();

    /* ===== ADMIN BYPASS (IMPORTANT) ===== */

    if (String(user.role).toLowerCase() === "admin") {
      return next();
    }

    /* ========================================================= */

    const now = Date.now();

    const lastEval = evaluationCache.get(user.id);

    if (lastEval && now - lastEval < EVAL_COOLDOWN_MS) {
      return next();
    }

    evaluationCache.set(user.id, now);

    /* ================= GEO ================= */

    const ip = extractIp(req);
    let geo = null;

    if (ip) geo = await geoLookup(ip);

    /* ================= THREAT ================= */

    const threat = evaluateThreat({
      ip,
      userAgent: req.headers["user-agent"],
      fingerprint: user.activeDeviceFingerprint,
      previousFingerprint: user.activeDeviceFingerprint,
      failedLogins: user.securityFlags?.failedLogins || 0
    });

    /* ================= RISK ================= */

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
      },
      role: user.role
    });

    const combinedScore = risk.riskScore;
    const level = risk.level;

    req.zeroTrust = {
      combinedScore,
      level
    };

    /* ================= AI MEMORY ================= */

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
        level
      });

      if (dbState.brain.decisions.length > MAX_AI_DECISIONS) {
        dbState.brain.decisions =
          dbState.brain.decisions.slice(-MAX_AI_DECISIONS);
      }

      return dbState;

    });

    /* ================= SECURITY EVENT ================= */

    if (level === "High" || level === "Critical") {

      updateDb(dbState => {

        dbState.securityEvents = dbState.securityEvents || [];

        dbState.securityEvents.push({
          id: `zt_${uid()}`,
          title: "Zero Trust Risk Evaluation",
          description: `Level: ${level}`,
          severity: level === "Critical" ? "critical" : "high",
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

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ZERO_TRUST_EVALUATION",
        detail: { combinedScore, level }
      });

    }

    /* ================= STRICT MODE ================= */

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
      action: "ZERO_TRUST_ERROR"
    });

    return next();

  }

}

module.exports = zeroTrust;
