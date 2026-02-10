// backend/src/routes/admin.pricing.routes.js
// Admin Pricing API — HARDENED
//
// PURPOSE:
// - Admin-controlled plans & pricing
// - No public writes
// - Audited changes
// - Tenant-safe
//
// RULES:
// - Admin only
// - No payment processing here
// - Pricing = configuration, not billing

const express = require("express");
const router = express.Router();

const { authRequired, requireRole } = require("../middleware/auth");
const { readDb, updateDb } = require("../lib/db");
const users = require("../users/user.service");

// ---------------- ROLE SAFETY ----------------
const ADMIN_ROLE = users?.ROLES?.ADMIN || "Admin";

// ---------------- MIDDLEWARE ----------------
router.use(authRequired);
router.use(requireRole(ADMIN_ROLE));

// ---------------- HELPERS ----------------
function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function audit(db, entry) {
  db.audit = db.audit || [];
  db.audit.push({
    id: crypto.randomUUID(),
    ts: Date.now(),
    actor: entry.actor,
    action: entry.action,
    target: entry.target || null,
    detail: entry.detail || {},
  });
}

// ---------------- DEFAULT PLANS ----------------
function ensurePricing(db) {
  if (!db.pricing) {
    db.pricing = {
      plans: [],
      updatedAt: Date.now(),
    };
  }
}

// =====================================================
// GET /api/admin/pricing
// =====================================================
router.get("/", (req, res) => {
  try {
    const db = readDb();
    ensurePricing(db);
    return res.json(db.pricing);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =====================================================
// POST /api/admin/pricing/plan
// Create or update a plan
// =====================================================
router.post("/plan", (req, res) => {
  try {
    const body = req.body || {};

    const plan = {
      id: cleanStr(body.id || crypto.randomUUID(), 100),
      name: cleanStr(body.name, 120),
      tier: cleanStr(body.tier, 50), // individual | small_company | company | admin
      priceMonthly: Number(body.priceMonthly || 0),
      priceYearly: Number(body.priceYearly || 0),
      features: Array.isArray(body.features)
        ? body.features.map((f) => cleanStr(f, 200))
        : [],
      limits: body.limits || {},
      active: body.active !== false,
      updatedAt: Date.now(),
    };

    if (!plan.name || !plan.tier) {
      return res.status(400).json({ error: "Missing plan name or tier" });
    }

    updateDb((db) => {
      ensurePricing(db);

      const idx = db.pricing.plans.findIndex((p) => p.id === plan.id);
      if (idx >= 0) {
        db.pricing.plans[idx] = plan;
      } else {
        db.pricing.plans.push(plan);
      }

      db.pricing.updatedAt = Date.now();

      audit(db, {
        actor: req.user.id,
        action: "PRICING_PLAN_UPSERT",
        target: plan.id,
        detail: { name: plan.name, tier: plan.tier },
      });

      return db;
    });

    return res.json({ ok: true, plan });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =====================================================
// DELETE /api/admin/pricing/plan/:id
// Soft delete (deactivate)
// =====================================================
router.delete("/plan/:id", (req, res) => {
  try {
    const planId = cleanStr(req.params.id, 100);

    updateDb((db) => {
      ensurePricing(db);

      const plan = db.pricing.plans.find((p) => p.id === planId);
      if (!plan) throw new Error("Plan not found");

      plan.active = false;
      plan.updatedAt = Date.now();
      db.pricing.updatedAt = Date.now();

      audit(db, {
        actor: req.user.id,
        action: "PRICING_PLAN_DEACTIVATED",
        target: planId,
        detail: { name: plan.name },
      });

      return db;
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
