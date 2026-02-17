// backend/src/routes/securityTools.routes.js
// Enterprise Security Tool API
// Tenant-aware • Admin override safe • Production hardened

const express = require("express");
const router = express.Router();

const {
  listTools,
  installTool,
  uninstallTool,
} = require("../services/securityTools");

/* =========================================================
   HELPERS
========================================================= */

function resolveTenantId(req) {
  // tenant middleware already resolved this
  if (req.tenant?.id) return req.tenant.id;

  // fallback (should rarely happen)
  if (req.companyId) return req.companyId;

  // admin global
  if (req.tenant?.type === "global") return "global";

  return null;
}

/* =========================================================
   LIST TOOLS
========================================================= */

router.get("/", (req, res) => {
  try {
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const installed = listTools(tenantId);

    return res.json({
      ok: true,
      tenantId,
      installed,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Failed to list tools",
    });
  }
});

/* =========================================================
   INSTALL TOOL
========================================================= */

router.post("/install", (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const toolId = String(req.body?.toolId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    if (!toolId) {
      return res.status(400).json({
        ok: false,
        error: "toolId required",
      });
    }

    const installed = installTool(tenantId, toolId);

    return res.json({
      ok: true,
      tenantId,
      installed,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Install failed",
    });
  }
});

/* =========================================================
   UNINSTALL TOOL
========================================================= */

router.post("/uninstall", (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const toolId = String(req.body?.toolId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    if (!toolId) {
      return res.status(400).json({
        ok: false,
        error: "toolId required",
      });
    }

    const installed = uninstallTool(tenantId, toolId);

    return res.json({
      ok: true,
      tenantId,
      installed,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Uninstall failed",
    });
  }
});

module.exports = router;
