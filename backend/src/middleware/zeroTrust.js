// backend/src/middleware/zeroTrust.js
// Enterprise Zero Trust Middleware — Adaptive Enforcement v4
// Deterministic • Tenant-Aware • WebSocket-Compatible • Memory-Bounded

const crypto = require("crypto");
const { readDb, updateDb } = require("../lib/db");
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
const MAX_SECURITY_EVENTS = 2000;

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

function uid() {
  return crypto.randomBytes(8).toString("hex");
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
    let geo = null;

    if (ip) {
      geo = await geoLookup(ip);
    }

    /* ================= THREAT ================= */

    const threat = evaluateThreat({
      ip,
      userAgent: req.headers["user-agent"],
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

    // Attach to request for downstream usage (UI parity, logging, WS layer)
    req.zeroTrust = {
      combinedScore,
      level,
      threatScore: threat.threatScore,
      riskScore: risk.riskScore
    };

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
        method: req.method,
        companyId: req.companyId || user.companyId || null
      }
    });

    /* ================= SECURITY EVENT ================= */

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

      // Memory bound
      if (dbState.securityEvents.length > MAX_SECURITY_EVENTS) {
        dbState.securityEvents = dbState.securityEvents.slice(-MAX_SECURITY_EVENTS);
      }

      return dbState;
    });

    /* ================= STRICT ENFORCEMENT ================= */

    if (ZERO_TRUST_STRICT && (level === "Critical" || level === "High")) {

      sessionAdapter.revokeAllUserSessions(user.id);

      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ZERO_TRUST_SESSION_TERMINATED",
        detail: {
          combinedScore,
          level
        }
      });

      return res.status(403).json({
        ok: false,
        error: "Security verification failed"
      });
    }

    return next();

  } catch (err) {

    writeAudit({
      actor: req.user?.id || "unknown",
      role: req.user?.role || "unknown",
      action: "ZERO_TRUST_ERROR",
      detail: {
        message: "ZeroTrust internal error"
      }
    });

    return next(); // fail-open but audited
  }
}

module.exports = zeroTrust;
