// backend/src/routes/me.routes.js
// Me Endpoints — Structured Dashboard • Tier Aware • Branch Controlled • Hardened

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { listNotifications, markRead } = require("../lib/notify");
const { audit } = require("../lib/audit");
const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { createProject } = require("../autoprotect/autoprotect.service");

router.use(authRequired);

/* =========================================================
   AUTH CONTEXT GUARD
========================================================= */

router.use((req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication context",
    });
  }
  next();
});

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function normRole(r) {
  return String(r || "").trim().toLowerCase();
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function canUseAutoDev(user) {
  const role = normRole(user.role);
  return role === normRole(users.ROLES?.INDIVIDUAL || "Individual");
}

/* =========================================================
   DASHBOARD (BRANCH FILTERED)
========================================================= */

router.get("/dashboard", (req, res) => {
  try {
    const user = req.user;

    let dashboardType = "individual";
    let branch = "member";
    let companyInfo = null;
    let visibleTools = [];
    let plan = null;

    if (user.companyId) {
      const company = companies.getCompany(user.companyId);

      if (company && company.status === "Active") {

        const memberRecord = company.members?.find(
          (m) => String(m.userId || m) === String(user.id)
        );

        if (memberRecord) {

          dashboardType = "company_member";

          if (typeof memberRecord === "object") {
            branch = memberRecord.position || "member";
          }

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

          // 🔐 Branch-aware tool visibility
          visibleTools =
            securityTools.getVisibleToolsForBranch(
              company.id,
              branch
            );
        }
      }
    }

    return res.json({
      ok: true,
      dashboard: {
        role: user.role,
        type: dashboardType,
        branch,
        plan,
        company: companyInfo,
        autoDevEnabled: canUseAutoDev(user),
        visibleTools,
      },
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

router.get("/notifications", (req, res) => {
  try {
    const notifications =
      listNotifications({ userId: req.user.id }) || [];

    return res.json({
      ok: true,
      notifications,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

router.post("/notifications/:id/read", (req, res) => {
  try {
    const id = cleanStr(req.params.id, 100);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing notification id",
      });
    }

    const existing =
      listNotifications({ userId: req.user.id })
        ?.find((n) => String(n.id) === id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "Notification not found",
      });
    }

    const n = markRead(id, req.user.id);

    return res.json({
      ok: true,
      notification: n,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* =========================================================
   PROJECT CREATION (INDIVIDUAL ONLY)
========================================================= */

router.post("/projects", (req, res) => {
  try {
    const user = req.user;

    if (!canUseAutoDev(user)) {
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

    if (!isObject(req.body.issue)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid issue payload",
      });
    }

    const issueType = cleanStr(req.body.issue.type, 100);
    const details = cleanStr(req.body.issue.details, 2000);

    if (!issueType) {
      return res.status(400).json({
        ok: false,
        error: "Missing issue.type",
      });
    }

    const project = createProject({
      actorId: user.id,
      companyId: user.companyId || null,
      title,
      issue: {
        type: issueType,
        details,
      },
    });

    audit({
      actorId: user.id,
      action: "PROJECT_CREATED",
      targetType: "Project",
      targetId: project.id,
    });

    return res.status(201).json({
      ok: true,
      project,
    });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
