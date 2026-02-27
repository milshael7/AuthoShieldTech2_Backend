// backend/src/routes/tools.routes.js
// AutoShield Tech — Enterprise Tools Engine v7
// Deterministic • Tenant-Enforced • Subscription-Verified • Memory-Bounded • Audit-Safe

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const {
  canAccessTool,
  seedToolsIfEmpty,
  normalizeArray,
} = require("../lib/tools.engine");

const MAX_TOOL_REQUESTS = 2000;
const MAX_ACTIVE_GRANTS = 5000;

/* ========================================================= */

function normalize(role) {
  return String(role || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function findUser(db, userId) {
  return (db.users || []).find((u) => String(u.id) === String(userId));
}

function subscriptionActive(user) {
  const s = normalize(user.subscriptionStatus);
  return s === "active" || s === "trial";
}

function isAdmin(user) {
  return normalize(user?.role) === "admin";
}

function isManager(user) {
  return normalize(user?.role) === "manager";
}

function ensureToolsState(db) {
  db.tools = normalizeArray(db.tools);
  if (!Array.isArray(db.toolRequests)) db.toolRequests = [];
  if (!Array.isArray(db.toolGrants)) db.toolGrants = [];
  return db;
}

function cleanupExpiredGrants(db) {
  const now = Date.now();
  db.toolGrants = (db.toolGrants || []).filter(
    g => g?.expiresAt && Date.parse(g.expiresAt) > now
  );
  return db;
}

function hasActiveGrant(db, { toolId, user }) {
  return db.toolGrants.some(g => {
    if (String(g.toolId) !== String(toolId)) return false;

    if (g.userId && String(g.userId) === String(user.id)) return true;

    if (g.companyId && user.companyId &&
        String(g.companyId) === String(user.companyId)) return true;

    return false;
  });
}

function clampDurationMinutes(user, minutes) {
  const requested = Number(minutes);
  const safe = Number.isFinite(requested) && requested > 0 ? requested : 1440;

  if (isAdmin(user)) return Math.min(safe, 2880);
  if (isManager(user)) return Math.min(safe, 120);

  return 1440;
}

/* ========================================================= */

router.use(authRequired);

/* =========================================================
   CATALOG
========================================================= */

router.get("/catalog", (req, res) => {
  try {
    const db = cleanupExpiredGrants(ensureToolsState(readDb()));
    seedToolsIfEmpty(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const tools = db.tools.map(tool => {
      const entitled =
        tool.enabled !== false &&
        subscriptionActive(user) &&
        canAccessTool(user, tool);

      const requiresApproval = Boolean(tool.requiresApproval || tool.dangerous);

      const grantOk = requiresApproval
        ? hasActiveGrant(db, { toolId: tool.id, user })
        : true;

      return {
        ...tool,
        requiresApproval,
        hasActiveGrant: grantOk,
        accessible: entitled && grantOk
      };
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_CATALOG_VIEWED"
    });

    return res.json({ ok: true, tools, time: nowIso() });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REQUEST TOOL
========================================================= */

router.post("/request/:toolId", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    if (!subscriptionActive(user)) {
      return res.status(403).json({ ok: false, error: "Subscription inactive" });
    }

    const tool = db.tools.find(
      t => String(t.id) === String(req.params.toolId)
    );
    if (!tool) return res.status(404).json({ ok: false });

    const duplicate = db.toolRequests.find(r =>
      r.toolId === tool.id &&
      r.requestedBy === user.id &&
      r.status === "pending_review"
    );

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        error: "Request already pending"
      });
    }

    const request = {
      id: uid("req"),
      toolId: tool.id,
      toolName: tool.name,
      requestedBy: user.id,
      requestedRole: user.role,
      companyId: req.companyId || null,
      status: tool.dangerous ? "pending_admin" : "pending_review",
      createdAt: nowIso(),
    };

    updateDb(db2 => {
      db2 = ensureToolsState(db2);
      db2.toolRequests.unshift(request);

      if (db2.toolRequests.length > MAX_TOOL_REQUESTS) {
        db2.toolRequests =
          db2.toolRequests.slice(-MAX_TOOL_REQUESTS);
      }

      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_REQUEST_CREATED",
      detail: { toolId: tool.id }
    });

    return res.json({ ok: true, request });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   APPROVE REQUEST
========================================================= */

router.post("/requests/:id/approve", (req, res) => {
  try {
    const db = cleanupExpiredGrants(ensureToolsState(readDb()));
    const approver = findUser(db, req.user.id);

    if (!isAdmin(approver) && !isManager(approver))
      return res.status(403).json({ ok: false });

    let grant = null;

    updateDb(db2 => {
      db2 = cleanupExpiredGrants(ensureToolsState(db2));

      const r = db2.toolRequests.find(x => x.id === req.params.id);
      if (!r) return db2;

      if (isManager(approver) &&
          String(r.companyId) !== String(req.companyId))
        return db2;

      const targetUser = findUser(db2, r.requestedBy);
      if (!subscriptionActive(targetUser)) return db2;

      const duration = clampDurationMinutes(
        approver,
        req.body?.durationMinutes
      );

      const expiresAt = new Date(
        Date.now() + duration * 60000
      ).toISOString();

      grant = {
        id: uid("grant"),
        toolId: r.toolId,
        userId: r.requestedBy,
        companyId: r.companyId,
        durationMinutes: duration,
        expiresAt,
        approvedBy: approver.id,
        approvedByRole: approver.role,
        createdAt: nowIso()
      };

      db2.toolGrants.unshift(grant);

      if (db2.toolGrants.length > MAX_ACTIVE_GRANTS) {
        db2.toolGrants =
          db2.toolGrants.slice(-MAX_ACTIVE_GRANTS);
      }

      r.status = "approved";
      r.expiresAt = expiresAt;

      return db2;
    });

    if (!grant) return res.status(403).json({ ok: false });

    audit({
      actor: approver.id,
      role: approver.role,
      action: "TOOL_REQUEST_APPROVED",
      detail: { toolId: grant.toolId }
    });

    return res.json({ ok: true, grant });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   GRANTS LIST
========================================================= */

router.get("/grants", (req, res) => {
  try {
    const db = cleanupExpiredGrants(readDb());
    const user = findUser(db, req.user.id);

    if (!isAdmin(user) && !isManager(user))
      return res.status(403).json({ ok: false });

    let grants = db.toolGrants || [];

    if (!isAdmin(user)) {
      grants = grants.filter(
        g => String(g.companyId) === String(req.companyId)
      );
    }

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_GRANTS_VIEWED"
    });

    return res.json({ ok: true, grants });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REVOKE GRANT
========================================================= */

router.post("/grants/:grantId/revoke", (req, res) => {
  try {
    const db = cleanupExpiredGrants(readDb());
    const user = findUser(db, req.user.id);

    if (!isAdmin(user))
      return res.status(403).json({ ok: false });

    updateDb(db2 => {
      db2.toolGrants =
        db2.toolGrants.filter(g => g.id !== req.params.grantId);
      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_GRANT_REVOKED",
      detail: { grantId: req.params.grantId }
    });

    return res.json({ ok: true });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
