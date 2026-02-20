// backend/src/routes/public.scans.routes.js
// Public Scan Routes — Tool Sales Engine • Queue Based

const express = require("express");
const router = express.Router();

const {
  createScan,
  processScan,
  getScan,
  TOOL_REGISTRY,
} = require("../services/scan.service");

/* =========================================================
   LIST PUBLIC TOOLS
========================================================= */

router.get("/tools", (req, res) => {
  try {
    const tools = Object.entries(TOOL_REGISTRY).map(
      ([id, tool]) => ({
        id,
        name: tool.name,
        price: tool.price,
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

    // If free tool → process immediately
    if (scan.price === 0) {
      processScan(scan.id);
    }

    return res.json({
      ok: true,
      scanId: scan.id,
      price: scan.price,
      status: scan.status,
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
