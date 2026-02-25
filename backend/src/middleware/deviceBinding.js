// backend/src/middleware/deviceBinding.js
// Enterprise Device Binding Middleware — v1
// Fingerprint Enforcement • Hijack Detection • Audit Safe

const { readDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");
const { revokeAllUserSessions } = require("../lib/sessionAdapter");
const { buildFingerprint } = require("../lib/deviceFingerprint");

/* =========================================================
   CONFIG
========================================================= */

const STRICT_MODE = process.env.DEVICE_BINDING_STRICT === "true";

/*
  STRICT_MODE = false (default)
  - Logs mismatch
  - Raises audit event
  - Does NOT block

  STRICT_MODE = true
  - Revokes sessions
  - Blocks request
*/

/* =========================================================
   MIDDLEWARE
========================================================= */

async function deviceBinding(req, res, next) {
  try {
    if (!req.user) {
      return next();
    }

    const db = readDb();
    const user = (db.users || []).find(u => u.id === req.user.id);

    if (!user) {
      return next();
    }

    const currentFingerprint = buildFingerprint(req);
    const storedFingerprint = user.activeDeviceFingerprint;

    // First login scenario
    if (!storedFingerprint) {
      return next();
    }

    // Match — allow
    if (storedFingerprint === currentFingerprint) {
      return next();
    }

    // Mismatch detected
    writeAudit({
      actor: user.id,
      role: user.role,
      action: "DEVICE_BINDING_MISMATCH",
      detail: {
        previousFingerprint: storedFingerprint,
        newFingerprint: currentFingerprint
      }
    });

    if (!STRICT_MODE) {
      return next();
    }

    // STRICT MODE: revoke sessions + block
    revokeAllUserSessions(user.id);

    return res.status(403).json({
      ok: false,
      error: "Device verification failed"
    });

  } catch {
    return next();
  }
}

module.exports = deviceBinding;
