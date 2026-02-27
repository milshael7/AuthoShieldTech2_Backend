// backend/src/middleware/deviceBinding.js
// Enterprise Device Binding Middleware — v2
// Risk Engine Based • Strict Safe • TokenVersion Safe • Audit Clean

const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const sessionAdapter = require("../lib/sessionAdapter");
const { classifyDeviceRisk } = require("../lib/deviceFingerprint");

const STRICT_MODE = process.env.DEVICE_BINDING_STRICT === "true";

/* ========================================================= */

async function deviceBinding(req, res, next) {
  try {
    if (!req.user) return next();

    const db = readDb();
    const user = (db.users || []).find(u => u.id === req.user.id);
    if (!user) return next();

    if (!user.activeDeviceFingerprint) return next();

    const deviceRisk = classifyDeviceRisk(
      user.activeDeviceFingerprint,
      req
    );

    if (deviceRisk.match) {
      return next();
    }

    /* ================= AUDIT ================= */

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "DEVICE_BINDING_MISMATCH",
      detail: {
        riskScore: deviceRisk.riskScore || null,
        reason: deviceRisk.reason || "fingerprint_mismatch"
      }
    });

    if (!STRICT_MODE) {
      return next();
    }

    /* ================= STRICT ENFORCEMENT ================= */

    sessionAdapter.revokeAllUserSessions(user.id);

    updateDb((db2) => {
      const u = db2.users.find(x => x.id === user.id);
      if (u) {
        u.tokenVersion = (u.tokenVersion || 0) + 1;
      }
      return db2;
    });

    return res.status(403).json({
      ok: false,
      error: "Device verification failed"
    });

  } catch {
    return next();
  }
}

module.exports = deviceBinding;
