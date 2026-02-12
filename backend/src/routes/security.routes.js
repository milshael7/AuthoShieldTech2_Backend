// backend/src/routes/security.routes.js
const express = require("express");
const router = express.Router();

const { listEvents } = require("../services/securityEvents");
const fs = require("fs");
const path = require("path");

/* =========================================================
   TOOL REGISTRY (Persistent)
   ========================================================= */

const TOOLS_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const TOOL_CATALOG = [
  { id: "edr", name: "Endpoint Detection & Response", weight: 15 },
  { id: "itdr", name: "Identity Threat Detection", weight: 15 },
  { id: "email", name: "Email Protection", weight: 20 },
  { id: "data", name: "Cloud Data Shield", weight: 15 },
  { id: "sat", name: "Security Awareness Training", weight: 10 },
  { id: "darkweb", name: "Dark Web Monitoring", weight: 10 },
];

let toolState = {};

function loadTools() {
  try {
    if (fs.existsSync(TOOLS_PATH)) {
      toolState = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8"));
    }
  } catch {
    toolState = {};
  }
}

function saveTools() {
  try {
    fs.writeFileSync(TOOLS_PATH, JSON.stringify(toolState, null, 2));
  } catch {}
}

loadTools();

/* =========================================================
   SCORE ENGINE
   ========================================================= */

function calculateSecurityScore() {
  const totalWeight = TOOL_CATALOG.reduce((sum, t) => sum + t.weight, 0);

  let activeWeight = 0;

  TOOL_CATALOG.forEach((tool) => {
    if (toolState[tool.id]) {
      activeWeight += tool.weight;
    }
  });

  const coverage = Math.round((activeWeight / totalWeight) * 100);

  return coverage;
}

function calculateIssues() {
  // Simple demo logic:
  // More missing tools = more issues

  const missing = TOOL_CATALOG.filter((t) => !toolState[t.id]).length;
  return missing;
}

/* =========================================================
   POSTURE (Dynamic Now)
   ========================================================= */

router.get("/posture", (req, res) => {
  const coverageScore = calculateSecurityScore();
  const issues = calculateIssues();

  const posture = {
    updatedAt: new Date().toISOString(),
    domains: [
      {
        key: "overall",
        label: "Overall Security",
        coverage: coverageScore,
        issues,
      },
    ],
  };

  return res.json({ ok: true, posture });
});

/* =========================================================
   LIVE SECURITY EVENTS
   ========================================================= */

router.get("/events", (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const severity = req.query.severity || null;

    const events = listEvents({ limit, severity });

    return res.json({
      ok: true,
      events,
    });
  } catch (err) {
    console.error("Security events error:", err);
    return res.status(500).json({
      ok: false,
      error: "Unable to fetch security events",
    });
  }
});

/* =========================================================
   TOOL LIST
   ========================================================= */

router.get("/tools", (req, res) => {
  const tools = TOOL_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    installed: !!toolState[tool.id],
  }));

  return res.json({ ok: true, tools });
});

/* =========================================================
   INSTALL TOOL
   ========================================================= */

router.post("/tools/:id/install", (req, res) => {
  const id = req.params.id;

  if (!TOOL_CATALOG.find((t) => t.id === id)) {
    return res.status(404).json({ ok: false, error: "Tool not found" });
  }

  toolState[id] = true;
  saveTools();

  return res.json({ ok: true, installed: true });
});

/* =========================================================
   UNINSTALL TOOL
   ========================================================= */

router.post("/tools/:id/uninstall", (req, res) => {
  const id = req.params.id;

  if (!TOOL_CATALOG.find((t) => t.id === id)) {
    return res.status(404).json({ ok: false, error: "Tool not found" });
  }

  delete toolState[id];
  saveTools();

  return res.json({ ok: true, installed: false });
});

module.exports = router;
