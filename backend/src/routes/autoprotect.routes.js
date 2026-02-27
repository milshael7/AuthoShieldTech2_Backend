// backend/src/routes/autoprotect.routes.js
// Autodev 6.5 — Hardened v2 (Blueprint + Tenant Model Aligned)
// Enforced via Tools Engine + Role Model
// Admin / Manager = Unlimited
// Individual ACTIVE = 10 Max
// Company roles = Not Allowed

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { writeAudit } = require("../lib/audit");

const { canAccessTool, seedToolsIfEmpty } = require("../lib/tools.engine");
const { autoProtectLimit, enforceLimit } = require("../lib/autodev");

router.use(authRequired);

/* ========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function normalize(role) {
  return String(role || "").trim().toLowerCase();
}

function subscriptionActive(user) {
  const s = String(user.subscriptionStatus || "").trim().toLowerCase();
  return s === "active" || s === "trial";
}

function isUnlimited(user) {
  const r = normalize(user.role);
  return r === "admin" || r === "manager";
}

function isBlockedRole(user) {
  // Blueprint: Company roles not allowed to use Autodev
  const r = normalize(user.role);
  return r === "company" || r === "small_company";
}

function getAutodevTool(db) {
  seedToolsIfEmpty(db);
  return (db.tools || []).find(t => String(t.id) === "autodev-65") || null;
}

function findDbUser(db, userId) {
  return (db.users || []).find(u => String(u.id) === String(userId)) || null;
}

function ensureManagedCompanies(user) {
  if (!Array.isArray(user.managedCompanies)) user.managedCompanies = [];
}

/* =========================================================
   STATUS
========================================================= */

router.get("/status", (req, res) => {
  try {
    const db = readDb();
    const user = findDbUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const tool = getAutodevTool(db);
    const allowedByTool =
      tool &&
      subscriptionActive(user) &&
      canAccessTool(user, tool);

    const blockedByRole = isBlockedRole(user);

    ensureManagedCompanies(user);

    const limit = isUnlimited(user) ? Infinity : autoProtectLimit(user);

    return res.json({
      ok: true,
      autodev: {
        allowed: Boolean(allowedByTool) && !blockedByRole,
        blockedReason: blockedByRole ? "role_not_allowed" : null,
        enabled: !!user.autoprotectEnabled,
        limit: limit === Infinity ? "unlimited" : limit,
        activeCompanies: user.managedCompanies,
        activeCount: user.managedCompanies.length
      },
      time: nowISO()
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ENABLE
========================================================= */

router.post("/enable", (req, res) => {
  try {
    const db = readDb();
    const user = findDbUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (isBlockedRole(user)) {
      return res.status(403).json({
        ok: false,
        error: "Autodev not permitted for company roles."
      });
    }

    const tool = getAutodevTool(db);
    const allowed =
      tool &&
      subscriptionActive(user) &&
      canAccessTool(user, tool);

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: "Autodev 6.5 not permitted for this account."
      });
    }

    ensureManagedCompanies(user);

    const check = enforceLimit(user);
    if (!check.ok) {
      return res.status(400).json({
        ok: false,
        error: check.error
      });
    }

    updateDb(db2 => {
      const u = findDbUser(db2, user.id);
      if (u) {
        u.autoprotectEnabled = true;
        u.updatedAt = nowISO();
      }
      return db2;
    });

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "AUTOPROTECT_ENABLED"
    });

    return res.json({
      ok: true,
      status: "ACTIVE",
      time: nowISO()
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   DISABLE
========================================================= */

router.post("/disable", (req, res) => {
  try {
    updateDb(db => {
      const u = findDbUser(db, req.user.id);
      if (u) {
        u.autoprotectEnabled = false;
        u.updatedAt = nowISO();
      }
      return db;
    });

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "AUTOPROTECT_DISABLED"
    });

    return res.json({
      ok: true,
      status: "INACTIVE",
      time: nowISO()
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ATTACH COMPANY
========================================================= */

router.post("/attach", (req, res) => {
  try {
    const { companyId } = req.body || {};
    if (!companyId) {
      return res.status(400).json({
        ok: false,
        error: "companyId required"
      });
    }

    const db = readDb();
    const user = findDbUser(db, req.user.id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (isBlockedRole(user)) {
      return res.status(403).json({
        ok: false,
        error: "Autodev not permitted for company roles."
      });
    }

    const tool = getAutodevTool(db);
    const allowed =
      tool &&
      subscriptionActive(user) &&
      canAccessTool(user, tool);

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: "Autodev not permitted."
      });
    }

    // Company existence check (prevents attaching random IDs)
    const companyExists = (db.companies || []).some(
      c => String(c.id) === String(companyId)
    );
    if (!companyExists) {
      return res.status(404).json({
        ok: false,
        error: "Company not found"
      });
    }

    ensureManagedCompanies(user);

    // Pre-check limit BEFORE write
    const projected = {
      ...user,
      managedCompanies: user.managedCompanies.includes(String(companyId))
        ? user.managedCompanies
        : [...user.managedCompanies, String(companyId)]
    };

    const check = enforceLimit(projected);
    if (!check.ok) {
      return res.status(400).json({
        ok: false,
        error: check.error
      });
    }

    updateDb(db2 => {
      const u = findDbUser(db2, user.id);
      if (!u) return db2;

      ensureManagedCompanies(u);

      const cid = String(companyId);
      if (!u.managedCompanies.includes(cid)) {
        u.managedCompanies.push(cid);
      }

      u.updatedAt = nowISO();
      return db2;
    });

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "AUTOPROTECT_COMPANY_ATTACHED",
      metadata: { companyId: String(companyId) }
    });

    const dbAfter = readDb();
    const updated = findDbUser(dbAfter, user.id);

    return res.json({
      ok: true,
      managedCompanies: updated?.managedCompanies || [],
      time: nowISO()
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   DETACH COMPANY
========================================================= */

router.post("/detach", (req, res) => {
  try {
    const { companyId } = req.body || {};
    if (!companyId) {
      return res.status(400).json({
        ok: false,
        error: "companyId required"
      });
    }

    updateDb(db => {
      const u = findDbUser(db, req.user.id);
      if (u) {
        ensureManagedCompanies(u);
        u.managedCompanies =
          u.managedCompanies.filter(c => String(c) !== String(companyId));
        u.updatedAt = nowISO();
      }
      return db;
    });

    writeAudit({
      actor: req.user.id,
      role: req.user.role,
      action: "AUTOPROTECT_COMPANY_DETACHED",
      metadata: { companyId: String(companyId) }
    });

    return res.json({
      ok: true,
      time: nowISO()
    });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
