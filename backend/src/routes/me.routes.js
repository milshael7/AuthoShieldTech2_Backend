// backend/src/routes/me.routes.js
// Me Endpoints — Subscription Enforced • Branch Controlled • Scan History Enabled

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { createProject } = require("../autoprotect/autoprotect.service");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function requireActiveSubscription(dbUser) {
  if (!dbUser) throw new Error("User not found");

  if (dbUser.subscriptionStatus === users.SUBSCRIPTION.LOCKED) {
    const err = new Error("Account locked");
    err.status = 403;
    throw err;
  }

  if (dbUser.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE) {
    const err = new Error("Subscription past due");
    err.status = 402;
    throw err;
  }
}

function requireActiveCompany(company) {
  if (!company || company.status !== "Active") {
    const err = new Error("Company not active");
    err.status = 403;
    throw err;
  }
}

/* =========================================================
   DASHBOARD
========================================================= */

router.get("/dashboard", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    if (!dbUser) {
      return res.status(404).json({ error: "User not found" });
    }

    requireActiveSubscription(dbUser);

    let dashboardType = "individual";
    let branch = "member";
    let companyInfo = null;
    let visibleTools = [];
    let plan = null;

    if (dbUser.companyId) {
      const company = companies.getCompany(dbUser.companyId);
      requireActiveCompany(company);

      const memberRecord = company.members?.find(
        (m) => String(m.userId || m) === String(dbUser.id)
      );

      if (memberRecord) {
        dashboardType = "company_member";
        branch =
          typeof memberRecord === "object"
            ? memberRecord.position || "member"
            : "member";

        plan = company.tier;

        companyInfo = {
          id: company.id,
          name: company.name,
          tier: company.tier,
          maxUsers: company.maxUsers,
          currentUsers: Array.isArray(company.members)
            ? company.members.length
            : 0,
        };

        visibleTools =
          securityTools.getVisibleToolsForBranch(
            company.id,
            branch
          );
      }
    }

    return res.json({
      ok: true,
      dashboard: {
        role: dbUser.role,
        type: dashboardType,
        branch,
        plan,
        company: companyInfo,
        subscriptionStatus: dbUser.subscriptionStatus,
        visibleTools,
      },
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   SCAN HISTORY (NEW)
========================================================= */

router.get("/scans", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const db = readDb();
    const allScans = Array.isArray(db.scans) ? db.scans : [];

    let scans = [];

    // Individual scans (by email)
    scans = allScans.filter(
      (s) => s.email === dbUser.email
    );

    // Company-level scans (future-ready)
    if (dbUser.companyId) {
      scans = allScans.filter(
        (s) =>
          s.email === dbUser.email ||
          s.companyId === dbUser.companyId
      );
    }

    // Sort newest first
    scans.sort(
      (a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.json({
      ok: true,
      total: scans.length,
      scans,
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const notifications =
      listNotifications({ userId: req.user.id }) || [];

    return res.json({
      ok: true,
      notifications,
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

router.post("/notifications/:id/read", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    const id = cleanStr(req.params.id, 100);
    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing notification id",
      });
    }

    const n = markRead(id, req.user.id);

    return res.json({
      ok: true,
      notification: n,
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   PROJECT CREATION
========================================================= */

router.post("/projects", (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    requireActiveSubscription(dbUser);

    if (dbUser.role !== users.ROLES.INDIVIDUAL) {
      return res.status(403).json({
        ok: false,
        error: "Upgrade required",
      });
    }

    if (!isObject(req.body)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request body",
      });
    }

    const title = cleanStr(req.body.title, 200);
    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Missing title",
      });
    }

    const issueType = cleanStr(req.body.issue?.type, 100);
    const details = cleanStr(req.body.issue?.details, 2000);

    if (!issueType) {
      return res.status(400).json({
        ok: false,
        error: "Missing issue.type",
      });
    }

    const project = createProject({
      actorId: dbUser.id,
      companyId: dbUser.companyId || null,
      title,
      issue: {
        type: issueType,
        details,
      },
    });

    audit({
      actorId: dbUser.id,
      action: "PROJECT_CREATED",
      targetType: "Project",
      targetId: project.id,
    });

    return res.status(201).json({
      ok: true,
      project,
    });

  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
