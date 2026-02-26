// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Hardened Access Enforcement v4
// COMPLETE GOVERNANCE LAYER

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");

const {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray,
} = require("../lib/tools.engine");

/* ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function findUser(db, userId) {
  return (db.users || []).find((u) => String(u.id) === String(userId));
}

function subscriptionActive(user) {
  const s = String(user.subscriptionStatus || "").toLowerCase();
  return s === "active" || s === "trial";
}

function ensureToolsState(db) {
  db.tools = normalizeArray(db.tools);
  if (!Array.isArray(db.toolRequests)) db.toolRequests = [];
  if (!Array.isArray(db.toolGrants)) db.toolGrants = [];
  return db;
}

function persistSeedIfNeeded(db) {
  const seeded = seedToolsIfEmpty(db);
  if (!seeded) return;

  updateDb((db2) => {
    db2 = ensureToolsState(db2);
    if (!Array.isArray(db2.tools) || db2.tools.length === 0) {
      db2.tools = db.tools;
    }
    return db2;
  });
}

function isAdmin(user) {
  return String(user?.role) === users.ROLES.ADMIN;
}

function isManager(user) {
  return String(user?.role) === users.ROLES.MANAGER;
}

function isCompany(user) {
  const r = String(user?.role);
  return r === users.ROLES.COMPANY || r === users.ROLES.SMALL_COMPANY;
}

function isIndividual(user) {
  return String(user?.role) === users.ROLES.INDIVIDUAL;
}

function isSeatUser(user) {
  return Boolean(user?.companyId) && !Boolean(user?.freedomEnabled);
}

/* =========================================================
   GRANT HELPERS
========================================================= */

function cleanupExpiredGrants(db) {
  db = ensureToolsState(db);
  const now = Date.now();

  db.toolGrants = (db.toolGrants || []).filter((g) => {
    if (!g?.expiresAt) return true;
    return Date.parse(g.expiresAt) > now;
  });

  return db;
}

function hasActiveGrant(db, { toolId, user }) {
  db = cleanupExpiredGrants(db);

  return (db.toolGrants || []).some((g) => {
    if (String(g.toolId) !== String(toolId)) return false;

    if (g.userId && String(g.userId) === String(user.id)) return true;

    if (g.companyId && user.companyId &&
        String(g.companyId) === String(user.companyId)) return true;

    return false;
  });
}

/* =========================================================
   ROUTER PROTECTION
========================================================= */

router.use(authRequired);

/* =========================================================
   GET CATALOG
========================================================= */

router.get("/catalog", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const tools = db.tools.map((tool) => {
      const baseEntitled =
        tool.enabled !== false &&
        subscriptionActive(user) &&
        canAccessTool(user, tool, users.ROLES);

      const needsApproval = Boolean(tool.requiresApproval || tool.dangerous);
      const grantOk = !needsApproval
        ? true
        : hasActiveGrant(db, { toolId: tool.id, user });

      return {
        ...tool,
        requiresApproval: needsApproval,
        hasActiveGrant: grantOk,
        accessible: baseEntitled && grantOk,
      };
    });

    return res.json({ ok: true, tools, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REQUEST TOOL
========================================================= */

router.post("/request/:toolId", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const tool = db.tools.find(
      (t) => String(t.id) === String(req.params.toolId)
    );
    if (!tool) return res.status(404).json({ ok: false });

    const stage = isSeatUser(user)
      ? "pending_company"
      : tool.dangerous
      ? "pending_admin"
      : "pending_review";

    const request = {
      id: uid("req"),
      toolId: tool.id,
      toolName: tool.name,
      toolDangerous: Boolean(tool.dangerous),
      requestedBy: user.id,
      requestedRole: user.role,
      companyId: user.companyId || null,
      seatUser: isSeatUser(user),
      status: stage,
      createdAt: nowIso(),
    };

    updateDb((db2) => {
      db2 = ensureToolsState(db2);
      db2.toolRequests.unshift(request);
      return db2;
    });

    return res.json({ ok: true, request });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   APPROVE REQUEST
========================================================= */

router.post("/requests/:id/approve", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);
    if (!isAdmin(user) && !isManager(user))
      return res.status(403).json({ ok: false });

    const requestId = req.params.id;
    let grant = null;

    updateDb((db2) => {
      db2 = cleanupExpiredGrants(db2);

      const r = db2.toolRequests.find((x) => x.id === requestId);
      if (!r) return db2;

      const duration = Number(req.body?.durationMinutes) || 1440;
      const expiresAt = new Date(
        Date.now() + duration * 60000
      ).toISOString();

      grant = {
        id: uid("grant"),
        toolId: r.toolId,
        userId: r.seatUser ? r.requestedBy : null,
        companyId: r.seatUser ? null : r.companyId,
        durationMinutes: duration,
        expiresAt,
        approvedBy: user.id,
        createdAt: nowIso(),
      };

      db2.toolGrants.unshift(grant);
      r.status = "approved";

      return db2;
    });

    return res.json({ ok: true, grant });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   DENY REQUEST
========================================================= */

router.post("/requests/:id/deny", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);
    if (!isAdmin(user) && !isManager(user))
      return res.status(403).json({ ok: false });

    updateDb((db2) => {
      const r = db2.toolRequests.find((x) => x.id === req.params.id);
      if (r) r.status = "denied";
      return db2;
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   LIST ACTIVE GRANTS
========================================================= */

router.get("/grants", (req, res) => {
  try {
    const db = cleanupExpiredGrants(readDb());
    const user = findUser(db, req.user.id);

    if (!isAdmin(user) && !isManager(user))
      return res.status(403).json({ ok: false });

    return res.json({ ok: true, grants: db.toolGrants });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REVOKE GRANT
========================================================= */

router.post("/grants/:grantId/revoke", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);

    if (!isAdmin(user))
      return res.status(403).json({ ok: false });

    updateDb((db2) => {
      db2.toolGrants = db2.toolGrants.filter(
        (g) => g.id !== req.params.grantId
      );
      return db2;
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   EXTEND GRANT
========================================================= */

router.post("/grants/:grantId/extend", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);

    if (!isAdmin(user))
      return res.status(403).json({ ok: false });

    const additional = Number(req.body?.durationMinutes);
    if (!additional || additional <= 0)
      return res.status(400).json({ ok: false });

    updateDb((db2) => {
      const g = db2.toolGrants.find(
        (x) => x.id === req.params.grantId
      );
      if (!g) return db2;

      const current = new Date(g.expiresAt).getTime();
      const newExpiry = new Date(
        current + additional * 60000
      ).toISOString();

      g.expiresAt = newExpiry;
      g.durationMinutes += additional;

      return db2;
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
