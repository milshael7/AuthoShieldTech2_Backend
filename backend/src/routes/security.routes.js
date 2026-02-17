const express = require("express");
const router = express.Router();

const { listEvents, recordEvent } = require("../services/securityEvents");
const securityTools = require("../services/securityTools");

/* =========================================================
   TOOL CATALOG (UI Reference Only)
========================================================= */

const TOOL_CATALOG = [
  { id: "edr", name: "Endpoint Detection & Response", domain: "endpoint", weight: 15 },
  { id: "itdr", name: "Identity Threat Detection", domain: "identity", weight: 15 },
  { id: "email", name: "Email Protection", domain: "email", weight: 20 },
  { id: "data", name: "Cloud Data Shield", domain: "cloud", weight: 15 },
  { id: "sat", name: "Security Awareness Training", domain: "awareness", weight: 10 },
  { id: "darkweb", name: "Dark Web Monitoring", domain: "threat", weight: 10 },
];

/* =========================================================
   DOMAIN LABELS
========================================================= */

const DOMAIN_LABELS = {
  endpoint: "Endpoint Security",
  identity: "Identity Protection",
  email: "Email Security",
  cloud: "Cloud Data Protection",
  awareness: "Security Awareness",
  threat: "Threat Intelligence",
};

/* =========================================================
   SCORE ENGINE (Service-backed)
========================================================= */

function calculateDomains(installedList) {
  const installed = new Set(installedList || []);
  const domains = {};

  TOOL_CATALOG.forEach((tool) => {
    if (!domains[tool.domain]) {
      domains[tool.domain] = {
        coverageWeight: 0,
        totalWeight: 0,
      };
    }

    domains[tool.domain].totalWeight += tool.weight;

    if (installed.has(tool.id)) {
      domains[tool.domain].coverageWeight += tool.weight;
    }
  });

  return Object.entries(domains).map(([key, val]) => {
    const coverage =
      val.totalWeight === 0
        ? 0
        : Math.round((val.coverageWeight / val.totalWeight) * 100);

    const issues = TOOL_CATALOG.filter(
      (t) => t.domain === key && !installed.has(t.id)
    ).length;

    return {
      key,
      label: DOMAIN_LABELS[key] || key,
      coverage,
      issues,
      weight: val.totalWeight,
    };
  });
}

function calculateOverall(domains) {
  if (!domains.length) return 0;

  const totalWeight = domains.reduce((sum, d) => sum + d.weight, 0);

  const weighted =
    domains.reduce((sum, d) => sum + d.coverage * d.weight, 0) /
    totalWeight;

  return Math.round(weighted);
}

function classifyScore(score) {
  if (score >= 90) return { tier: "Hardened", risk: "Low" };
  if (score >= 75) return { tier: "Strong", risk: "Low" };
  if (score >= 60) return { tier: "Stable", risk: "Moderate" };
  if (score >= 40) return { tier: "Weak", risk: "High" };
  return { tier: "Critical", risk: "Severe" };
}

/* =========================================================
   POSTURE
========================================================= */

router.get("/posture", (req, res) => {
  try {
    const tenantId = req.tenant?.id;

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const { installed } = securityTools.listTools(tenantId);

    const domains = calculateDomains(installed);
    const overall = calculateOverall(domains);
    const classification = classifyScore(overall);

    return res.json({
      ok: true,
      posture: {
        updatedAt: new Date().toISOString(),
        score: overall,
        tier: classification.tier,
        risk: classification.risk,
        domains,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Failed to calculate posture",
    });
  }
});

/* =========================================================
   TOOL LIST
========================================================= */

router.get("/tools", (req, res) => {
  try {
    const tenantId = req.tenant?.id;

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const { installed, blocked } =
      securityTools.listTools(tenantId);

    const tools = TOOL_CATALOG.map((tool) => ({
      id: tool.id,
      name: tool.name,
      domain: tool.domain,
      installed: installed.includes(tool.id),
      blocked: blocked.includes(tool.id),
    }));

    return res.json({ ok: true, tools });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Failed to list tools",
    });
  }
});

/* =========================================================
   INSTALL
========================================================= */

router.post("/tools/:id/install", (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const toolId = req.params.id;

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const updated = securityTools.installTool(
      tenantId,
      toolId,
      req.user?.id
    );

    recordEvent({
      type: "tool_install",
      severity: "info",
      source: "security_tools",
      target: toolId,
      description: `Installed tool: ${toolId}`,
      meta: { tenantId },
    });

    return res.json({ ok: true, installed: updated });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || "Install failed",
    });
  }
});

/* =========================================================
   UNINSTALL
========================================================= */

router.post("/tools/:id/uninstall", (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    const toolId = req.params.id;

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "Tenant context missing",
      });
    }

    const updated = securityTools.uninstallTool(
      tenantId,
      toolId,
      req.user?.id
    );

    recordEvent({
      type: "tool_uninstall",
      severity: "warn",
      source: "security_tools",
      target: toolId,
      description: `Uninstalled tool: ${toolId}`,
      meta: { tenantId },
    });

    return res.json({ ok: true, installed: updated });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || "Uninstall failed",
    });
  }
});

/* =========================================================
   EVENTS (Tenant Filtered)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const severity = req.query.severity || null;

    const events = listEvents({ limit, severity });

    return res.json({ ok: true, events });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Unable to fetch security events",
    });
  }
});

module.exports = router;
