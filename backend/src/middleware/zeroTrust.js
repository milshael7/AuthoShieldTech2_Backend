// backend/src/middleware/zeroTrust.js
// Enterprise Zero Trust Middleware — Adaptive Enforcement v1
// Risk Engine • Threat Intel • Escalation • Optional Hard Block

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

/*
  ZERO_TRUST_STRICT = false (default)
    - Logs high risk
    - Creates security event
    - Does NOT block

  ZERO_TRUST_STRICT = true
    - Revokes sessions
    - Blocks request
*/

/* =========================================================
   MAIN MIDDLEWARE
========================================================= */

async function zeroTrust(req, res, next) {
  try {
    if (!req.user) {
      return next();
    }

    const db = readDb();
    const user = (db.users || []).find(u => u.id === req.user.id);

    if (!user) {
      return next();
    }

    const ip = extractIp(req);
    const geo = await geoLookup(ip);

    const threat = evaluateThreat({
      ip,
      userAgent: req.headers["user-agent"],
      fingerprint: req.securityContext?.fingerprint,
      previousFingerprint: user.activeDeviceFingerprint,
      failedLogins: user.securityFlags?.failedLogins || 0
    });

    const risk = calculateRisk({
      geo,
      device: {
        userAgent: req.headers["user-agent"],
        language: req.headers["accept-language"],
        timezone: geo?.region
      },
      session: {
        activeSessions: sessionAdapter.getActiveSessionCount(user.id)
      },
      behavior: {
        failedLogins: user.securityFlags?.failedLogins || 0
      }
    });

    const combinedScore = Math.min(
      100,
      Math.round((threat.threatScore + risk.riskScore) / 2)
    );

    let level = "Low";
    if (combinedScore >= 70) level = "Critical";
    else if (combinedScore >= 45) level = "High";
    else if (combinedScore >= 25) level = "Medium";

    if (level === "High" || level === "Critical") {
      writeAudit({
        actor: user.id,
        role: user.role,
        action: "ZERO_TRUST_ELEVATED_RISK",
        detail: {
          combinedScore,
          level,
          ip,
          geo
        }
      });

      db.securityEvents = db.securityEvents || [];

      const event = {
        id: Date.now().toString(),
        title: "Zero Trust Elevated Risk",
        description: `Risk level: ${level}`,
        severity: level === "Critical" ? "critical" : "high",
        companyId: user.companyId || null,
        createdAt: new Date().toISOString()
      };

      db.securityEvents.push(event);
      writeDb(db);

      if (ZERO_TRUST_STRICT && level === "Critical") {
        sessionAdapter.revokeAllUserSessions(user.id);

        return res.status(403).json({
          ok: false,
          error: "Security verification failed"
        });
      }
    }

    return next();

  } catch {
    return next();
  }
}

module.exports = zeroTrust;
