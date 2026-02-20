// backend/src/routes/public.scans.routes.js
// Public Scan Routes — Credit Enforced • Discount Accurate • Hardened

const express = require("express");
const router = express.Router();

const {
  createScan,
  processScan,
  getScan,
  TOOL_REGISTRY,
} = require("../services/scan.service");

const {
  createToolCheckoutSession,
} = require("../services/stripe.service");

const { verify } = require("../lib/jwt");
const { readDb, updateDb } = require("../lib/db");
const { getUserEffectivePlan } = require("../users/user.service");

/* =========================================================
   OPTIONAL AUTH
========================================================= */

function getOptionalUser(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();

  try {
    const payload = verify(token);
    const db = readDb();
    return db.users.find((u) => u.id === payload.id) || null;
  } catch {
    return null;
  }
}

/* =========================================================
   SAFE INPUT
========================================================= */

function sanitizeInput(input = {}) {
  return {
    depth:
      input.depth === "deep" || input.depth === "enterprise"
        ? input.depth
        : "standard",

    urgency:
      input.urgency === "rush"
        ? "rush"
        : "normal",

    targets: Math.max(
      1,
      Math.min(Number(input.targets) || 1, 100)
    ),
  };
}

/* =========================================================
   LIST TOOLS
========================================================= */

router.get("/tools", (req, res) => {
  try {
    const tools = Object.entries(TOOL_REGISTRY).map(
      ([id, tool]) => ({
        id,
        name: tool.name,
        basePrice: tool.basePrice,
        pricingModel: tool.pricingModel,
        type: tool.type,
      })
    );

    return res.json({ ok: true, tools });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   CREATE SCAN
========================================================= */

router.post("/", async (req, res) => {
  try {
    const { toolId, email, inputData } = req.body;

    if (!toolId || !email) {
      return res.status(400).json({
        ok: false,
        error: "toolId and email required",
      });
    }

    if (!TOOL_REGISTRY[toolId]) {
      return res.status(400).json({
        ok: false,
        error: "Invalid tool",
      });
    }

    const user = getOptionalUser(req);

    // 🔒 Prevent impersonation
    if (user && user.email !== email) {
      return res.status(403).json({
        ok: false,
        error: "Email mismatch",
      });
    }

    const safeInput = sanitizeInput(inputData);

    const scan = createScan({
      toolId,
      email,
      inputData: safeInput,
      user,
    });

    /* ================= CREDIT OR FREE ================= */

    if (scan.finalPrice === 0) {
      processScan(scan.id);

      return res.json({
        ok: true,
        scanId: scan.id,
        finalPrice: 0,
        creditUsed: scan.creditUsed || false,
        status: "processing",
      });
    }

    /* ================= DISCOUNT ================= */

    let finalCharge = scan.finalPrice;
    let discountPercent = 0;
    let planLabel = "Public";

    if (user) {
      const plan = getUserEffectivePlan(user);
      discountPercent = plan.discountPercent || 0;
      planLabel = plan.label;

      finalCharge = Math.round(
        scan.finalPrice -
          (scan.finalPrice * discountPercent) / 100
      );

      updateDb((db) => {
        const s = db.scans?.find((x) => x.id === scan.id);
        if (s) {
          s.finalPrice = finalCharge;
          s.discountPercent = discountPercent;
          s.planLabel = planLabel;
        }
      });
    }

    const successUrl =
      process.env.STRIPE_TOOL_SUCCESS_URL ||
      "https://yourdomain.com/scan-success";

    const cancelUrl =
      process.env.STRIPE_TOOL_CANCEL_URL ||
      "https://yourdomain.com/scan-cancel";

    const checkoutUrl = await createToolCheckoutSession({
      scanId: scan.id,
      amount: finalCharge,
      successUrl,
      cancelUrl,
    });

    return res.json({
      ok: true,
      scanId: scan.id,
      basePrice: scan.basePrice,
      finalCharge,
      discountPercent,
      planLabel,
      checkoutUrl,
      status: "awaiting_payment",
    });

  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   GET SCAN
========================================================= */

router.get("/:id", (req, res) => {
  try {
    const scan = getScan(req.params.id);

    if (!scan) {
      return res.status(404).json({
        ok: false,
        error: "Scan not found",
      });
    }

    return res.json({ ok: true, scan });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
