// backend/src/routes/securityTools.routes.js
// Enterprise Security Tool API
// Tenant-aware • Production-ready

const express = require("express");
const router = express.Router();

const {
  listTools,
  installTool,
  uninstallTool,
} = require("../services/securityTools");

// NOTE:
// tenantMiddleware already runs before this route.
// We expect req.tenant or req.companyId to exist.

function getCompanyId(req) {
  return (
    req.tenant?.companyId ||
    req.companyId ||
    "default"
  );
}

/* ================= LIST ================= */

router.get("/", (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const installed = listTools(companyId);

    return res.json({
      ok: true,
      installed,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Failed to list tools",
    });
  }
});

/* ================= INSTALL ================= */

router.post("/install", (req, res) => {
  try {
    const { toolId } = req.body;
    if (!toolId) {
      return res.status(400).json({
        ok: false,
        error: "toolId required",
      });
    }

    const companyId = getCompanyId(req);
    const installed = installTool(companyId, toolId);

    return res.json({
      ok: true,
      installed,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Install failed",
    });
  }
});

/* ================= UNINSTALL ================= */

router.post("/uninstall", (req, res) => {
  try {
    const { toolId } = req.body;
    if (!toolId) {
      return res.status(400).json({
        ok: false,
        error: "toolId required",
      });
    }

    const companyId = getCompanyId(req);
    const installed = uninstallTool(companyId, toolId);

    return res.json({
      ok: true,
      installed,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Uninstall failed",
    });
  }
});

module.exports = router;
