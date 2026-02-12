// backend/src/routes/security.routes.js
const express = require("express");
const router = express.Router();

const { listEvents } = require("../services/securityEvents");
const fs = require("fs");
const path = require("path");

/* =========================================================
   SIMPLE TOOL REGISTRY (Persistent)
   ========================================================= */

const TOOLS_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const TOOL_CATALOG = [
  { id: "edr", name: "Endpoint Detection & Response" },
  { id: "itdr", name: "Identity Threat Detection" },
  { id: "email", name: "Email Protection" },
  { id: "data", name: "Cloud Data Shield" },
  { id: "sat", name: "Security Awareness Training" },
  { id: "darkweb", name: "Dark Web Monitoring" },
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
   POSTURE (Radar + Coverage)
   ========================================================= */
router.get("/posture", (req, res) => {
  const posture = {
    updatedAt: new Date().toISOString(),
    domains: [
      { key: "email", label: "Email Protection", coverage: 82, issues: 2 },
      { key: "endpoint", label: "Endpoint Security", coverage: 76, issues: 4 },
      { key: "awareness", label: "Security Awareness", coverage: 68, issues: 1 },
      { key: "phishing", label: "Phishing Simulations", coverage: 55, issues: 3 },
      { key: "itdr", label: "ITDR", coverage: 61, issues: 2 },
      { key: "external", label: "External Footprint", coverage: 73, issues: 5 },
      { key: "darkweb", label: "Dark Web", coverage: 64, issues: 1 },
      { key: "cloud", label: "Cloud Data", coverage: 70, issues: 2 },
      { key: "browsing", label: "Secure Browsing", coverage: 79, issues: 2 },
    ],
  };

  return res.json({ ok: true, posture });
});

/* =========================================================
   LIVE SECURITY EVENTS (SOC FEED)
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
    ...tool,
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
