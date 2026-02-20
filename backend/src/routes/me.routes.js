// backend/src/routes/me.routes.js
// Me Endpoints — Enterprise Hardened
// Subscription Enforced • Invoice PDF Enabled • Tenant Safe • Audit Enabled

const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { listNotifications } = require("../lib/notify");

const users = require("../users/user.service");
const companies = require("../companies/company.service");
const securityTools = require("../services/securityTools");
const { createProject } = require("../autoprotect/autoprotect.service");
const { getUserEffectivePlan } = require("../users/user.service");
const {
  getUserInvoices,
  getInvoicePdf,
} = require("../services/invoice.service");

router.use(authRequired);

/* =========================================================
   HELPERS
========================================================= */

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

function requireActiveSubscription(user) {
  if (!user) {
    const err = new Error("User not found");
    err.status = 401;
    throw err;
  }

  if (user.subscriptionStatus === users.SUBSCRIPTION.LOCKED) {
    const err = new Error("Account locked");
    err.status = 403;
    throw err;
  }

  if (user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE) {
    const err = new Error("Subscription past due");
    err.status = 402;
    throw err;
  }
}

function getDbUser(id) {
  return users.findById(id);
}

/* =========================================================
   🔥 INVOICE LIST
========================================================= */

router.get("/invoices", (req, res) => {
  try {
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    const invoices = getUserInvoices(dbUser.id);

    res.json({
      ok: true,
      total: invoices.length,
      invoices,
    });

  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   🔥 INVOICE PDF DOWNLOAD
========================================================= */

router.get("/invoices/:id/pdf", (req, res) => {
  try {
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    const invoiceId = clean(req.params.id, 100);

    const db = readDb();
    const invoice = db.invoices.find(
      (i) => i.id === invoiceId && i.userId === dbUser.id
    );

    if (!invoice) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found",
      });
    }

    const filePath = getInvoicePdf(invoiceId);

    audit({
      actorId: dbUser.id,
      action: "DOWNLOAD_INVOICE_PDF",
      targetType: "Invoice",
      targetId: invoiceId,
    });

    res.download(filePath);

  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   USAGE
========================================================= */

router.get("/usage", (req, res) => {
  try {
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    const db = readDb();
    const plan = getUserEffectivePlan(dbUser);
    const included = plan.includedScans || 0;
    const monthKey = currentMonthKey();

    let used = 0;

    if (db.scanCredits?.[dbUser.id]?.month === monthKey) {
      used = db.scanCredits[dbUser.id].used;
    }

    const remaining =
      included === Infinity
        ? Infinity
        : Math.max(0, included - used);

    res.json({
      ok: true,
      usage: {
        planLabel: plan.label,
        included,
        used,
        remaining,
        month: monthKey,
      },
    });

  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   DASHBOARD
========================================================= */

router.get("/dashboard", (req, res) => {
  try {
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    res.json({
      ok: true,
      dashboard: {
        role: dbUser.role,
        subscriptionStatus: dbUser.subscriptionStatus,
        companyId: dbUser.companyId || null,
      },
    });

  } catch (e) {
    res.status(e.status || 500).json({
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
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    const notifications =
      listNotifications({ userId: dbUser.id }) || [];

    res.json({ ok: true, notifications });

  } catch (e) {
    res.status(e.status || 500).json({
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
    const dbUser = getDbUser(req.user.id);
    requireActiveSubscription(dbUser);

    if (!isObject(req.body)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request body",
      });
    }

    const title = clean(req.body.title, 200);
    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "Missing title",
      });
    }

    const project = createProject({
      actorId: dbUser.id,
      companyId: dbUser.companyId || null,
      title,
      issue: req.body.issue || {},
    });

    audit({
      actorId: dbUser.id,
      action: "PROJECT_CREATED",
      targetType: "Project",
      targetId: project.id,
    });

    res.status(201).json({
      ok: true,
      project,
    });

  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
