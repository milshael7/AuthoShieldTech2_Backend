// backend/src/routes/tools.routes.js
// Enterprise Tools Engine — Hardened Access Enforcement v3.1
// Catalog + Strict Access + Time-Limited Tool Grants
// Seat → Company Request → Admin/Manager Approval (timed) → Auto Expire
// Audited • Abuse Aware • Backward Compatible

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

function uid(prefix = "req") {
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
  // IMPORTANT: don't wipe if tools is an object (normalize instead)
  db.tools = normalizeArray(db.tools);

  if (!Array.isArray(db.toolRequests)) db.toolRequests = [];
  if (!Array.isArray(db.toolGrants)) db.toolGrants = [];
  return db;
}

function persistSeedIfNeeded(db) {
  // Seed tools if empty AND persist to db.json
  const seeded = seedToolsIfEmpty(db);
  if (!seeded) return;

  updateDb((db2) => {
    db2 = ensureToolsState(db2);
    // if db2.tools already exists, keep it; otherwise persist db.tools
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

/**
 * "Seat user" = user is under a company AND has NOT purchased freedom yet.
 * We use: companyId + freedomEnabled false (or missing).
 */
function isSeatUser(user) {
  return Boolean(user?.companyId) && !Boolean(user?.freedomEnabled);
}

function recordToolViolation(user, toolId, reason) {
  audit({
    actor: user.id,
    role: user.role,
    action: "TOOL_ACCESS_DENIED",
    target: toolId,
    metadata: { reason },
  });

  updateDb((db) => {
    db = ensureToolsState(db);
    const u = db.users.find((x) => x.id === user.id);
    if (!u) return db;

    if (!u.securityFlags) u.securityFlags = {};
    u.securityFlags.toolViolations = (u.securityFlags.toolViolations || 0) + 1;

    if (u.securityFlags.toolViolations >= 5) {
      u.locked = true;
      audit({
        actor: u.id,
        role: u.role,
        action: "ACCOUNT_AUTO_LOCKED_TOOL_ABUSE",
      });
    }

    return db;
  });
}

/* =========================================================
   GRANTS (TIME BOX)
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
  db = ensureToolsState(db);
  db = cleanupExpiredGrants(db);

  const now = Date.now();

  return (db.toolGrants || []).some((g) => {
    if (String(g.toolId) !== String(toolId)) return false;
    if (!g.expiresAt) return false;
    if (Date.parse(g.expiresAt) <= now) return false;

    // user-scoped grant
    if (g.userId && String(g.userId) === String(user.id)) return true;

    // company-scoped grant
    if (g.companyId && user.companyId && String(g.companyId) === String(user.companyId)) return true;

    return false;
  });
}

/* =========================================================
   REQUEST ROUTING LOGIC
========================================================= */

/**
 * Mark tools with:
 *  - tool.requiresApproval = true
 *  - tool.dangerous = true
 *  - tool.maxDurationMinutes = number (cap)
 */
function toolRequiresApproval(tool) {
  return Boolean(tool?.requiresApproval) || Boolean(tool?.dangerous);
}

function resolveRequestStage(user, tool) {
  // Seats must go to company first
  if (isSeatUser(user)) return "pending_company";

  // Company / Individual go straight to review (admin+manager inbox)
  if (isCompany(user) || isIndividual(user)) return "pending_review";

  // Manager can request, but dangerous tools require admin-only approval
  if (isManager(user)) {
    if (Boolean(tool?.dangerous)) return "pending_admin";
    return "pending_review";
  }

  // Admin can self-approve, but we still model as review
  if (isAdmin(user)) return "pending_review";

  return "pending_review";
}

function canApproveRequest(approver, request, tool) {
  if (!approver) return false;
  if (approver.locked) return false;

  // Company cannot approve tool grants (only forward/deny seat requests)
  if (isCompany(approver)) return false;

  if (isAdmin(approver)) return true;

  if (isManager(approver)) {
    // manager cannot approve dangerous tools
    if (Boolean(tool?.dangerous)) return false;
    return true;
  }

  return false;
}

function clampDurationMinutes(approver, tool, requestedMinutes) {
  // Defaults:
  // manager: 120 mins (2 hours)
  // admin: 1440 mins (1 day)
  const mgrMax = 120;
  const adminDefault = 1440;
  const adminMax = 2880; // 2 days

  let mins = Number(requestedMinutes);
  if (!Number.isFinite(mins) || mins <= 0) {
    mins = isAdmin(approver) ? adminDefault : mgrMax;
  }

  // tool cap if provided
  const toolCap = Number(tool?.maxDurationMinutes);
  if (Number.isFinite(toolCap) && toolCap > 0) {
    mins = Math.min(mins, toolCap);
  }

  if (isAdmin(approver)) {
    mins = Math.min(mins, adminMax);
    return mins;
  }

  if (isManager(approver)) {
    mins = Math.min(mins, mgrMax);
    return mins;
  }

  return mins;
}

/**
 * Grant scope rules (matches what you described):
 * - Seat request: grant is USER-scoped (only that seat user can use it)
 * - Company request: grant is COMPANY-scoped (company + its seats can use it)
 * - Individual request: USER-scoped
 */
function buildGrantScopeFromRequest(request) {
  const requestedRole = String(request?.requestedRole || "");

  if (request?.seatUser) {
    return { companyId: null, userId: request.requestedBy };
  }

  if (requestedRole === users.ROLES.COMPANY || requestedRole === users.ROLES.SMALL_COMPANY) {
    return { companyId: request.companyId || null, userId: null };
  }

  // default (individual/manager/admin)
  return { companyId: null, userId: request.requestedBy };
}

/* ========================================================= */

router.use(authRequired);

/* =========================================================
   GET CATALOG
========================================================= */

router.get("/catalog", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const toolsArr = normalizeArray(db.tools);

    const tools = toolsArr.map((tool) => {
      const baseEntitled =
        tool.enabled !== false &&
        subscriptionActive(user) &&
        canAccessTool(user, tool, users.ROLES);

      const needsApproval = toolRequiresApproval(tool);
      const grantOk = !needsApproval ? true : hasActiveGrant(db, { toolId: tool.id, user });

      return {
        id: tool.id,
        name: tool.name,
        description: tool.description || "",
        tier: tool.tier || "free",
        category: tool.category || "security",
        enabled: tool.enabled !== false,

        requiresApproval: needsApproval,
        hasActiveGrant: needsApproval ? grantOk : true,

        accessible: baseEntitled && grantOk,
      };
    });

    return res.json({ ok: true, tools, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   STRICT TOOL ACCESS
========================================================= */

router.get("/access/:toolId", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const { toolId } = req.params;
    const toolsArr = normalizeArray(db.tools);

    const tool = toolsArr.find((t) => String(t.id) === String(toolId));
    if (!tool) return res.status(404).json({ ok: false, error: "Tool not found" });

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    if (tool.enabled === false) {
      recordToolViolation(user, toolId, "TOOL_DISABLED");
      return res.status(403).json({ ok: false, error: "Tool disabled" });
    }

    if (!subscriptionActive(user)) {
      recordToolViolation(user, toolId, "INACTIVE_SUBSCRIPTION");
      return res.status(403).json({ ok: false, error: "Subscription inactive" });
    }

    const entitled = canAccessTool(user, tool, users.ROLES);
    if (!entitled) {
      recordToolViolation(user, toolId, "ENTITLEMENT_DENIED");
      return res.status(403).json({ ok: false, error: "Access denied" });
    }

    if (toolRequiresApproval(tool)) {
      const grantOk = hasActiveGrant(db, { toolId: tool.id, user });
      if (!grantOk) {
        audit({
          actor: user.id,
          role: user.role,
          action: "TOOL_ACCESS_BLOCKED_APPROVAL_REQUIRED",
          target: toolId,
        });
        return res.status(403).json({
          ok: false,
          error: "Tool requires approval",
          requiresApproval: true,
        });
      }
    }

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_ACCESS_GRANTED",
      target: toolId,
    });

    return res.json({
      ok: true,
      tool: {
        id: tool.id,
        name: tool.name,
        tier: tool.tier,
        category: tool.category,
        requiresApproval: toolRequiresApproval(tool),
      },
      time: nowIso(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   REQUEST TOOL ACCESS
   POST /api/tools/request/:toolId
   body: { note?: string }
========================================================= */

router.post("/request/:toolId", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const { toolId } = req.params;
    const toolsArr = normalizeArray(db.tools);
    const tool = toolsArr.find((t) => String(t.id) === String(toolId));
    if (!tool) return res.status(404).json({ ok: false, error: "Tool not found" });

    if (tool.enabled === false) {
      return res.status(403).json({ ok: false, error: "Tool disabled" });
    }

    if (!subscriptionActive(user)) {
      return res.status(403).json({ ok: false, error: "Subscription inactive" });
    }

    const entitled = canAccessTool(user, tool, users.ROLES);
    if (!entitled) {
      recordToolViolation(user, toolId, "REQUEST_ENTITLEMENT_DENIED");
      return res.status(403).json({ ok: false, error: "Not entitled to request this tool" });
    }

    // Seat must have companyId; if missing, treat as invalid seat state
    if (isSeatUser(user) && !user.companyId) {
      return res.status(400).json({ ok: false, error: "Seat user missing company binding" });
    }

    const stage = resolveRequestStage(user, tool);
    const requestId = uid("toolreq");
    const note = String(req.body?.note || "").trim().slice(0, 600);

    const request = {
      id: requestId,
      toolId: String(tool.id),
      toolName: tool.name,
      toolDangerous: Boolean(tool?.dangerous),
      requiresApproval: toolRequiresApproval(tool),

      requestedBy: String(user.id),
      requestedRole: String(user.role),
      companyId: user.companyId || null,

      status: stage, // pending_company | pending_review | pending_admin

      seatUser: isSeatUser(user),
      note,

      createdAt: nowIso(),
      updatedAt: nowIso(),

      forwardedByCompanyUserId: null,
      forwardedAt: null,

      decidedBy: null,
      decidedByRole: null,
      decision: null, // approved | denied
      decisionNote: null,
      durationMinutes: null,
      expiresAt: null,
    };

    updateDb((db2) => {
      db2 = ensureToolsState(db2);
      db2.toolRequests.unshift(request);
      return db2;
    });

    audit({
      actor: user.id,
      role: user.role,
      action: "TOOL_REQUEST_CREATED",
      target: toolId,
      metadata: { requestId, status: stage, seatUser: request.seatUser },
    });

    return res.json({
      ok: true,
      requestId,
      status: stage,
      message:
        stage === "pending_company"
          ? "Request sent to your company for approval forwarding"
          : "Request sent for review",
      time: nowIso(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   INBOX
   GET /api/tools/requests/inbox
========================================================= */

router.get("/requests/inbox", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const requests = normalizeArray(db.toolRequests);
    let inbox = [];

    if (isCompany(user)) {
      // Company sees seat requests for their companyId ONLY
      if (!user.companyId) return res.json({ ok: true, inbox: [], time: nowIso() });

      inbox = requests.filter(
        (r) =>
          r.status === "pending_company" &&
          String(r.companyId || "") === String(user.companyId)
      );
    } else if (isAdmin(user)) {
      inbox = requests.filter((r) => r.status === "pending_review" || r.status === "pending_admin");
    } else if (isManager(user)) {
      inbox = requests.filter((r) => r.status === "pending_review");
    }

    return res.json({ ok: true, inbox, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   COMPANY FORWARD
   POST /api/tools/requests/:requestId/forward
========================================================= */

router.post("/requests/:requestId/forward", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const actor = findUser(db, req.user.id);
    if (!actor) return res.status(404).json({ ok: false, error: "User not found" });
    if (!isCompany(actor)) return res.status(403).json({ ok: false, error: "Company only" });
    if (!actor.companyId) return res.status(400).json({ ok: false, error: "Company missing companyId binding" });

    const requestId = String(req.params.requestId);
    const note = String(req.body?.note || "").trim().slice(0, 600);

    let updated = null;

    updateDb((db2) => {
      db2 = ensureToolsState(db2);

      const r = (db2.toolRequests || []).find((x) => String(x.id) === requestId);
      if (!r) return db2;

      if (String(r.companyId || "") !== String(actor.companyId)) return db2;
      if (r.status !== "pending_company") return db2;

      r.status = r.toolDangerous ? "pending_admin" : "pending_review";
      r.forwardedByCompanyUserId = String(actor.id);
      r.forwardedAt = nowIso();
      r.updatedAt = nowIso();

      if (note) {
        r.note = [r.note, `Company note: ${note}`].filter(Boolean).join("\n\n");
      }

      updated = r;
      return db2;
    });

    if (!updated) {
      return res.status(404).json({ ok: false, error: "Request not found or not forwardable" });
    }

    audit({
      actor: actor.id,
      role: actor.role,
      action: "TOOL_REQUEST_FORWARDED",
      target: updated.toolId,
      metadata: { requestId: updated.id, status: updated.status },
    });

    return res.json({ ok: true, request: updated, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   APPROVE
   POST /api/tools/requests/:requestId/approve
========================================================= */

router.post("/requests/:requestId/approve", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const approver = findUser(db, req.user.id);
    if (!approver) return res.status(404).json({ ok: false, error: "User not found" });

    const requestId = String(req.params.requestId);
    const note = String(req.body?.note || "").trim().slice(0, 600);

    const toolsArr = normalizeArray(db.tools);

    let responseRequest = null;
    let grant = null;

    updateDb((db2) => {
      db2 = ensureToolsState(db2);
      db2 = cleanupExpiredGrants(db2);

      const r = (db2.toolRequests || []).find((x) => String(x.id) === requestId);
      if (!r) return db2;

      const tool = toolsArr.find((t) => String(t.id) === String(r.toolId));
      if (!tool) return db2;

      if (!["pending_review", "pending_admin"].includes(String(r.status))) return db2;
      if (!canApproveRequest(approver, r, tool)) return db2;

      const durationMinutes = clampDurationMinutes(approver, tool, req.body?.durationMinutes);
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

      const scope = buildGrantScopeFromRequest(r);

      const grantId = uid("grant");
      grant = {
        id: grantId,
        toolId: String(tool.id),
        createdAt: nowIso(),
        expiresAt,
        approvedBy: String(approver.id),
        approvedByRole: String(approver.role),
        durationMinutes,

        companyId: scope.companyId,
        userId: scope.userId,
      };

      db2.toolGrants.unshift(grant);

      r.status = "approved";
      r.decision = "approved";
      r.decidedBy = String(approver.id);
      r.decidedByRole = String(approver.role);
      r.decisionNote = note || null;
      r.durationMinutes = durationMinutes;
      r.expiresAt = expiresAt;
      r.updatedAt = nowIso();

      responseRequest = r;
      return db2;
    });

    if (!responseRequest) {
      return res.status(403).json({
        ok: false,
        error: "Not approved (not found, not pending, or insufficient authority)",
      });
    }

    audit({
      actor: approver.id,
      role: approver.role,
      action: "TOOL_REQUEST_APPROVED",
      target: responseRequest.toolId,
      metadata: {
        requestId: responseRequest.id,
        expiresAt: responseRequest.expiresAt,
        durationMinutes: responseRequest.durationMinutes,
        scope: { companyId: grant?.companyId || null, userId: grant?.userId || null },
      },
    });

    return res.json({ ok: true, request: responseRequest, grant, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   DENY
   POST /api/tools/requests/:requestId/deny
========================================================= */

router.post("/requests/:requestId/deny", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    persistSeedIfNeeded(db);

    const decider = findUser(db, req.user.id);
    if (!decider) return res.status(404).json({ ok: false, error: "User not found" });

    const requestId = String(req.params.requestId);
    const note = String(req.body?.note || "").trim().slice(0, 600);

    const toolsArr = normalizeArray(db.tools);
    let responseRequest = null;

    updateDb((db2) => {
      db2 = ensureToolsState(db2);

      const r = (db2.toolRequests || []).find((x) => String(x.id) === requestId);
      if (!r) return db2;

      const tool = toolsArr.find((t) => String(t.id) === String(r.toolId));
      if (!tool) return db2;

      if (!["pending_review", "pending_admin", "pending_company"].includes(String(r.status))) return db2;

      // Company can deny ONLY pending_company requests for their company
      if (isCompany(decider)) {
        if (!decider.companyId) return db2;
        const okCompany =
          r.status === "pending_company" &&
          String(r.companyId || "") === String(decider.companyId);
        if (!okCompany) return db2;
      } else {
        // Admin can deny anything; Manager cannot deny dangerous pending_admin
        if (isManager(decider) && Boolean(tool?.dangerous) && r.status === "pending_admin") return db2;
        if (!isAdmin(decider) && !isManager(decider)) return db2;
      }

      r.status = "denied";
      r.decision = "denied";
      r.decidedBy = String(decider.id);
      r.decidedByRole = String(decider.role);
      r.decisionNote = note || null;
      r.updatedAt = nowIso();

      responseRequest = r;
      return db2;
    });

    if (!responseRequest) {
      return res.status(403).json({
        ok: false,
        error: "Not denied (not found or insufficient authority)",
      });
    }

    audit({
      actor: decider.id,
      role: decider.role,
      action: "TOOL_REQUEST_DENIED",
      target: responseRequest.toolId,
      metadata: { requestId: responseRequest.id },
    });

    return res.json({ ok: true, request: responseRequest, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   MY REQUESTS
   GET /api/tools/requests/mine
========================================================= */

router.get("/requests/mine", (req, res) => {
  try {
    const db = ensureToolsState(readDb());
    const user = findUser(db, req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const requests = normalizeArray(db.toolRequests).filter(
      (r) => String(r.requestedBy) === String(user.id)
    );

    return res.json({ ok: true, requests, time: nowIso() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
