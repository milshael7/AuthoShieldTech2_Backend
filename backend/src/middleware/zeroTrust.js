// backend/src/middleware/zeroTrust.js
// Enterprise Zero Trust Middleware — Adaptive Enforcement v2
// Risk + Threat Correlation • Smart Escalation • Strict Optional Block

const { readDb, writeDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const { calculateRisk } = require("../lib/riskEngine");
const { evaluateThreat } = require("../lib/threatIntel");
const { geoLookup, extractIp } = require("../lib/geoLookup");
const sessionAdapter = require("../lib/sessionAdapter");

/* =========================================================
   CONFIG
========================================================= */

const ZERO_TRUST_STRICT = process.env.ZERO_TRUST_STRICT === "true";
const ZERO_TRUST_ENABLED = process.env.ZERO_TRUST_ENABLED !== "false";

/*
  ZERO_TRUST_ENABLED=false
    → Middleware bypassed

  ZERO_TRUST_STRICT=true
    → Critical risk revokes sessions + blocks
*/

/* =========================================================
   HELPERS
========================================================= */

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function deriveLevel(score) {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

/* =========================================================
   MAIN MIDDLEWARE
========================================================= */

async function zeroTrust(req, res, next) {
  try {
    if (!ZERO_TRUST_ENABLED) return next();
    if (!req.user) return next();

    const db = readDb();
    const user = (db.users || []).find(u => u.id === req.user.id);
    if (!user) return next();

    const ip = extractIp(req);

    /* ================= GEO (lazy) ================= */

    let geo = null;
    if (ip) {
      geo = await geoLookup(ip);
    }

    /* ================= THREAT ================= */

    const threat = evaluateThreat({
      ip,
      userAgent: req.headers["user-agent"],
      fingerprint: req.securityContext?.fingerprint,
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
      }
    });

    /* ================= CORRELATION ================= */

    const combinedScore = clamp(
      Math.round((threat.threatScore * 0.6) + (risk.riskScore * 0.4)),
      0,
      100
    );

    const level = deriveLevel(combinedScore);

    /* ================= LOW RISK FAST EXIT ================= */

    if (level === "Low") {
      return next();
    }

    /* ================= AUDIT ================= */

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "ZERO_TRUST_EVALUATION",
      detail: {
        combinedScore,
        level,
        threatScore: threat.threatScore,
        riskScore: risk.riskScore,
        path: req.originalUrl,
        method: req.method
      }
    });

    /* ================= SECURITY EVENT ================= */

    db.securityEvents = db.securityEvents || [];

    const event = {
      id: Date.now().toString(),
      title: "Zero Trust Risk Evaluation",
      description: `Level: ${level}`,
      severity:
        level === "Critical"
          ? "critical"
          : level === "High"
          ? "high"
          : "medium",
      companyId: user.companyId || null,
      userId: user.id,
      createdAt: new Date().toISOString()
    };

    db.securityEvents.push(event);
    writeDb(db);

    /* ================= STRICT ENFORCEMENT ================= */

    if (ZERO_TRUST_STRICT && level === "Critical") {

      sessionAdapter.revokeAllUserSessions(user.id);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ZERO_TRUST_SESSION_TERMINATED",
        detail: { combinedScore }
      });

      return res.status(403).json({
        ok: false,
        error: "Security verification failed"
      });
    }

    return next();

  } catch {
    return next();
  }
}

module.exports = zeroTrust;
