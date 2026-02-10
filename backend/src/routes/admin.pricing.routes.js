// backend/src/routes/admin.pricing.routes.js
// Admin Pricing API — HARDENED (FIXED)
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
const { audit } = require("../lib/audit");
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

// ---------------- DEFAULT PRICING ----------------
function ensurePricing(db) {
  if (!db.pricing) {
    db.pricing = {
      plans: [],
      updatedAt: new Date().toISOString(),
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
      id: cleanStr(body.id || cryptoSafeId(), 100),
      name: cleanStr(body.name, 120),
      tier: cleanStr(body.tier, 50), // individual | small_company | company | admin
      priceMonthly: Number(body.priceMonthly || 0),
      priceYearly: Number(body.priceYearly || 0),
      features: Array.isArray(body.features)
        ? body.features.map((f) => cleanStr(f, 200))
        : [],
      limits: typeof body.limits === "object" ? body.limits : {},
      active: body.active !== false,
      updatedAt: new Date().toISOString(),
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

      db.pricing.updatedAt = new Date().toISOString();

      audit({
        actorId: req.user.id,
        action: "PRICING_PLAN_UPSERT",
        targetType: "pricing_plan",
        targetId: plan.id,
        companyId: req.user.companyId || null,
        metadata: {
          name: plan.name,
          tier: plan.tier,
          active: plan.active,
        },
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
      plan.updatedAt = new Date().toISOString();
      db.pricing.updatedAt = new Date().toISOString();

      audit({
        actorId: req.user.id,
        action: "PRICING_PLAN_DEACTIVATED",
        targetType: "pricing_plan",
        targetId: planId,
        companyId: req.user.companyId || null,
        metadata: { name: plan.name },
      });

      return db;
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// ---------------- SAFE ID ----------------
function cryptoSafeId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

module.exports = router;
