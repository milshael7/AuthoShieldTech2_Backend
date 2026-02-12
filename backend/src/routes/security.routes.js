const express = require("express");
const router = express.Router();

const { listEvents } = require("../services/securityEvents");
const fs = require("fs");
const path = require("path");

/* =========================================================
   STORAGE PATHS
   ========================================================= */

const TOOLS_PATH =
  process.env.SECURITY_TOOLS_PATH ||
  path.join("/tmp", "security_tools.json");

const HISTORY_PATH =
  process.env.SECURITY_HISTORY_PATH ||
  path.join("/tmp", "security_score_history.json");

/* =========================================================
   TOOL CATALOG
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
   STATE
   ========================================================= */

let toolState = {};
let scoreHistory = [];

/* =========================================================
   LOAD / SAVE
   ========================================================= */

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

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      scoreHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    }
  } catch {
    scoreHistory = [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(scoreHistory, null, 2));
  } catch {}
}

loadTools();
loadHistory();

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
   SCORE ENGINE
   ========================================================= */

function calculateDomains() {
  const domains = {};

  TOOL_CATALOG.forEach((tool) => {
    if (!domains[tool.domain]) {
      domains[tool.domain] = {
        coverageWeight: 0,
        totalWeight: 0,
      };
    }

    domains[tool.domain].totalWeight += tool.weight;

    if (toolState[tool.id]) {
      domains[tool.domain].coverageWeight += tool.weight;
    }
  });

  return Object.entries(domains).map(([key, val]) => {
    const coverage =
      val.totalWeight === 0
        ? 0
        : Math.round((val.coverageWeight / val.totalWeight) * 100);

    const issues = TOOL_CATALOG.filter(
      (t) => t.domain === key && !toolState[t.id]
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

function calculateTrend(currentScore) {
  if (scoreHistory.length === 0) return "stable";

  const last = scoreHistory[scoreHistory.length - 1];

  if (!last) return "stable";

  if (currentScore > last.score) return "up";
  if (currentScore < last.score) return "down";
  return "stable";
}

function recordHistory(score) {
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    score,
  };

  scoreHistory.push(entry);

  if (scoreHistory.length > 200) {
    scoreHistory = scoreHistory.slice(-200);
  }

  saveHistory();
}

/* =========================================================
   POSTURE
   ========================================================= */

router.get("/posture", (req, res) => {
  const domains = calculateDomains();
  const overall = calculateOverall(domains);
  const classification = classifyScore(overall);
  const trend = calculateTrend(overall);

  recordHistory(overall);

  const posture = {
    updatedAt: new Date().toISOString(),
    score: overall,
    tier: classification.tier,
    risk: classification.risk,
    trend,
    domains,
  };

  return res.json({ ok: true, posture });
});

/* =========================================================
   SCORE HISTORY (NEW)
   ========================================================= */

router.get("/score-history", (req, res) => {
  return res.json({
    ok: true,
    history: scoreHistory.slice(-50),
  });
});

/* =========================================================
   EVENTS
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

/* =========================================================
   TOOL LIST
   ========================================================= */

router.get("/tools", (req, res) => {
  const tools = TOOL_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    domain: tool.domain,
    installed: !!toolState[tool.id],
  }));

  return res.json({ ok: true, tools });
});

/* =========================================================
   INSTALL / UNINSTALL
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
