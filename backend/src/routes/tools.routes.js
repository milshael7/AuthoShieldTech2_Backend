// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Hardened Access Enforcement v5
// Full Governance Layer • Admin/Manager Boundaries • Expiry Safety • Audit Complete

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

function isAdmin(user) {
  return String(user?.role) === users.ROLES.ADMIN;
}

function isManager(user) {
  return String(user?.role) === users.ROLES.MANAGER;
}

function isSeatUser(user) {
  return Boolean(user?.companyId) && !Boolean(user?.freedomEnabled);
}

function cleanupExpiredGrants(db) {
  const now = Date.now();
  db.toolGrants = (db.toolGrants || []).filter(g =>
    g?.expiresAt && Date.parse(g.expiresAt) > now
  );
  return db;
}

function hasActiveGrant(db, { toolId, user }) {
  db = cleanupExpiredGrants(db);

  return db.toolGrants.some(g => {
    if (String(g.toolId) !== String(toolId)) return false;

    if (g.userId && String(g.userId) === String(user.id)) return true;

    if (g.companyId && user.companyId &&
        String(g.companyId) === String(user.companyId)) return true;

    return false;
  });
}

function clampDurationMinutes(user, tool, minutes) {
  const requested = Number(minutes);
  const safe = Number.isFinite(requested) && requested > 0 ? requested : 1440;

  const maxAdmin = 2880;
  const maxManager = 120;

  if (isAdmin(user)) return Math.min(safe, maxAdmin);
  if (isManager(user)) return Math.min(safe, maxManager);

  return 1440;
}

/* ========================================================= */

router.use(authRequired);

/* =========================================================
   CATALOG
========================================================= */

router.get("/catalog", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    seedToolsIfEmpty(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const tools = db.tools.map(tool => {
      const entitled =
        tool.enabled !== false &&
        subscriptionActive(user) &&
        canAccessTool(user, tool, users.ROLES);

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
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false });

    const tool = db.tools.find(t => String(t.id) === String(req.params.toolId));
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

    updateDb(db2 => {
      db2 = ensureToolsState(db2);
      db2.toolRequests.unshift(request);
      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_REQUEST_CREATED",
      target: tool.id
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
    const db = ensureToolsState(readDb());
    const approver = findUser(db, req.user.id);

    if (!isAdmin(approver) && !isManager(approver))
      return res.status(403).json({ ok: false });

    let grant = null;

    updateDb(db2 => {
      db2 = cleanupExpiredGrants(db2);

      const r = db2.toolRequests.find(x => x.id === req.params.id);
      if (!r) return db2;

      if (r.status !== "pending_review" && r.status !== "pending_admin")
        return db2;

      if (isManager(approver) && r.toolDangerous)
        return db2;

      const tool = db2.tools.find(t => t.id === r.toolId);
      if (!tool) return db2;

      const duration = clampDurationMinutes(
        approver,
        tool,
        req.body?.durationMinutes
      );

      const expiresAt = new Date(Date.now() + duration * 60000).toISOString();

      grant = {
        id: uid("grant"),
        toolId: r.toolId,
        userId: r.seatUser ? r.requestedBy : null,
        companyId: r.seatUser ? null : r.companyId,
        durationMinutes: duration,
        expiresAt,
        approvedBy: approver.id,
        approvedByRole: approver.role,
        createdAt: nowIso()
      };

      db2.toolGrants.unshift(grant);
      r.status = "approved";
      r.decidedBy = approver.id;
      r.decidedByRole = approver.role;
      r.expiresAt = expiresAt;

      return db2;
    });

    if (!grant) return res.status(403).json({ ok: false });

    audit({
      actor: approver.id,
      role: approver.role,
      action: "TOOL_REQUEST_APPROVED",
      target: grant.toolId
    });

    return res.json({ ok: true, grant });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

/* =========================================================
   DENY REQUEST
========================================================= */

router.post("/requests/:id/deny", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const decider = findUser(db, req.user.id);

    if (!isAdmin(decider) && !isManager(decider))
      return res.status(403).json({ ok: false });

    updateDb(db2 => {
      const r = db2.toolRequests.find(x => x.id === req.params.id);
      if (!r) return db2;

      r.status = "denied";
      r.decidedBy = decider.id;
      r.decidedByRole = decider.role;
      r.updatedAt = nowIso();

      return db2;
    });

    audit({
      actor: decider.id,
      role: decider.role,
      action: "TOOL_REQUEST_DENIED"
    });

    return res.json({ ok: true });

  } catch {
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

  } catch {
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

    updateDb(db2 => {
      db2.toolGrants = db2.toolGrants.filter(
        g => g.id !== req.params.grantId
      );
      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_GRANT_REVOKED"
    });

    return res.json({ ok: true });

  } catch {
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

    updateDb(db2 => {
      const g = db2.toolGrants.find(x => x.id === req.params.grantId);
      if (!g) return db2;

      const current = new Date(g.expiresAt).getTime();
      g.expiresAt = new Date(current + additional * 60000).toISOString();
      g.durationMinutes += additional;
      g.updatedAt = nowIso();

      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_GRANT_EXTENDED"
    });

    return res.json({ ok: true });

  } catch {
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
