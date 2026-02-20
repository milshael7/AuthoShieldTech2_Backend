// backend/src/routes/public.scans.routes.js
// Public Scan Routes — Tool Sales Engine • Dynamic Pricing Ready

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

/* =========================================================
   LIST PUBLIC TOOLS
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

    return res.json({
      ok: true,
      tools,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

/* =========================================================
   CREATE SCAN (FREE OR PAID)
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

    const scan = createScan({
      toolId,
      email,
      inputData: inputData || {},
    });

    /* ---------------- FREE TOOL ---------------- */

    if (scan.finalPrice === 0) {
      processScan(scan.id);

      return res.json({
        ok: true,
        scanId: scan.id,
        finalPrice: 0,
        status: "processing",
      });
    }

    /* ---------------- PAID TOOL ---------------- */

    const successUrl =
      process.env.STRIPE_TOOL_SUCCESS_URL ||
      "https://yourdomain.com/scan-success";

    const cancelUrl =
      process.env.STRIPE_TOOL_CANCEL_URL ||
      "https://yourdomain.com/scan-cancel";

    const checkoutUrl = await createToolCheckoutSession({
      scanId: scan.id,
      amount: scan.finalPrice,
      successUrl,
      cancelUrl,
    });

    return res.json({
      ok: true,
      scanId: scan.id,
      basePrice: scan.basePrice,
      finalPrice: scan.finalPrice,
      pricingModel: scan.pricingModel,
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
   GET SCAN STATUS / RESULT
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

    return res.json({
      ok: true,
      scan,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

module.exports = router;
