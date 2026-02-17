const express = require("express");
const router = express.Router();

const { listEvents, recordEvent } = require("../services/securityEvents");

/* =========================================================
   TOOL CATALOG (GLOBAL DEFINITION — STATE IS TENANT)
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
   TENANT STATE (IN MEMORY — ISOLATED)
========================================================= */

const TENANT_STATE = {}; // { tenantId: { tools, history, lastScore } }

function ensureTenant(tenantId) {
  if (!tenantId) tenantId = "global";

  if (!TENANT_STATE[tenantId]) {
    TENANT_STATE[tenantId] = {
      tools: {},
      history: [],
      lastScore: null,
    };
  }

  return TENANT_STATE[tenantId];
}

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
   SCORE ENGINE (TENANT-AWARE)
========================================================= */

function calculateDomains(tools) {
  const domains = {};

  TOOL_CATALOG.forEach((tool) => {
    if (!domains[tool.domain]) {
      domains[tool.domain] = {
        coverageWeight: 0,
        totalWeight: 0,
      };
    }

    domains[tool.domain].totalWeight += tool.weight;

    if (tools[tool.id]) {
      domains[tool.domain].coverageWeight += tool.weight;
    }
  });

  return Object.entries(domains).map(([key, val]) => {
    const coverage =
      val.totalWeight === 0
        ? 0
        : Math.round((val.coverageWeight / val.totalWeight) * 100);

    const issues = TOOL_CATALOG.filter(
      (t) => t.domain === key && !tools[t.id]
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
  const tenantId = req.tenant?.id || "global";
  const tenant = ensureTenant(tenantId);

  const domains = calculateDomains(tenant.tools);
  const overall = calculateOverall(domains);
  const classification = classifyScore(overall);

  if (tenant.lastScore !== overall) {
    tenant.history.push({
      ts: Date.now(),
      iso: new Date().toISOString(),
      score: overall,
    });

    if (tenant.history.length > 200) {
      tenant.history = tenant.history.slice(-200);
    }

    // Alert on critical drop
    if (
      tenant.lastScore !== null &&
      tenant.lastScore - overall >= 15
    ) {
      recordEvent({
        tenantId,
        type: "posture_drop",
        severity: "critical",
        description: `Security posture dropped by ${
          tenant.lastScore - overall
        } points`,
      });
    }

    tenant.lastScore = overall;
  }

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
});

/* =========================================================
   SCORE HISTORY
========================================================= */

router.get("/score-history", (req, res) => {
  const tenantId = req.tenant?.id || "global";
  const tenant = ensureTenant(tenantId);

  return res.json({
    ok: true,
    history: tenant.history.slice(-50),
  });
});

/* =========================================================
   EVENTS (TENANT ISOLATED)
========================================================= */

router.get("/events", (req, res) => {
  try {
    const tenantId = req.tenant?.id || "global";
    const limit = Number(req.query.limit) || 50;
    const severity = req.query.severity || null;

    const events = listEvents({
      tenantId,
      limit,
      severity,
    });

    return res.json({ ok: true, events });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Unable to fetch security events",
    });
  }
});

/* =========================================================
   TOOL LIST (TENANT-SCOPED)
========================================================= */

router.get("/tools", (req, res) => {
  const tenantId = req.tenant?.id || "global";
  const tenant = ensureTenant(tenantId);

  const tools = TOOL_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    domain: tool.domain,
    installed: !!tenant.tools[tool.id],
  }));

  return res.json({ ok: true, tools });
});

/* =========================================================
   INSTALL / UNINSTALL (TENANT-SCOPED)
========================================================= */

router.post("/tools/:id/install", (req, res) => {
  const tenantId = req.tenant?.id || "global";
  const tenant = ensureTenant(tenantId);
  const id = req.params.id;

  if (!TOOL_CATALOG.find((t) => t.id === id)) {
    return res.status(404).json({ ok: false, error: "Tool not found" });
  }

  tenant.tools[id] = true;

  recordEvent({
    tenantId,
    type: "tool_install",
    severity: "info",
    description: `Installed tool: ${id}`,
  });

  return res.json({ ok: true, installed: true });
});

router.post("/tools/:id/uninstall", (req, res) => {
  const tenantId = req.tenant?.id || "global";
  const tenant = ensureTenant(tenantId);
  const id = req.params.id;

  if (!TOOL_CATALOG.find((t) => t.id === id)) {
    return res.status(404).json({ ok: false, error: "Tool not found" });
  }

  delete tenant.tools[id];

  recordEvent({
    tenantId,
    type: "tool_uninstall",
    severity: "warn",
    description: `Uninstalled tool: ${id}`,
  });

  return res.json({ ok: true, installed: false });
});

module.exports = router;
