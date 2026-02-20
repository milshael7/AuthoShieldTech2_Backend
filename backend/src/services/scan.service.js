// backend/src/services/scan.service.js
// Scan Engine — Queue Based • Revenue Ready • Upgrade Structured

const { nanoid } = require("nanoid");
const { readDb, writeDb, updateDb } = require("../lib/db");

/* =========================================================
   TOOL REGISTRY (INITIAL)
========================================================= */

const TOOL_REGISTRY = {
  "vulnerability-scan": {
    name: "Vulnerability Scan",
    price: 199,
    type: "paid",
  },
  "dark-web-scan": {
    name: "Dark Web Exposure Scan",
    price: 299,
    type: "paid",
  },
  "basic-risk": {
    name: "Basic Risk Assessment",
    price: 0,
    type: "free",
  },
};

/* =========================================================
   CREATE SCAN
========================================================= */

function createScan({ toolId, email, inputData }) {
  const tool = TOOL_REGISTRY[toolId];
  if (!tool) throw new Error("Invalid tool");

  const scan = {
    id: nanoid(),
    toolId,
    toolName: tool.name,
    email,
    inputData,
    price: tool.price,
    status: tool.price > 0 ? "awaiting_payment" : "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  };

  updateDb((db) => {
    db.scans.push(scan);
  });

  return scan;
}

/* =========================================================
   MARK SCAN PAID
========================================================= */

function markScanPaid(scanId) {
  updateDb((db) => {
    const scan = db.scans.find((s) => s.id === scanId);
    if (!scan) return;

    if (scan.status === "awaiting_payment") {
      scan.status = "pending";
    }
  });
}

/* =========================================================
   PROCESS SCAN (SIMULATED ENGINE)
========================================================= */

function processScan(scanId) {
  updateDb((db) => {
    const scan = db.scans.find((s) => s.id === scanId);
    if (!scan || scan.status !== "pending") return;

    scan.status = "running";
  });

  // simulate processing delay
  setTimeout(() => {
    updateDb((db) => {
      const scan = db.scans.find((s) => s.id === scanId);
      if (!scan) return;

      const riskScore = generateRiskScore();

      scan.status = "completed";
      scan.completedAt = new Date().toISOString();
      scan.result = generateReport(scan, riskScore);
    });
  }, 4000);
}

/* =========================================================
   RISK LOGIC (SIMULATED)
========================================================= */

function generateRiskScore() {
  return Math.floor(Math.random() * 60) + 20; // 20–80 realistic range
}

function generateReport(scan, riskScore) {
  return {
    riskScore,
    severityBreakdown: {
      critical: Math.floor(riskScore / 25),
      high: Math.floor(riskScore / 15),
      medium: Math.floor(riskScore / 10),
      low: 2,
    },
    summary: [
      "External exposure detected.",
      "Surface vulnerabilities identified.",
      "No internal network testing performed.",
    ],
    recommendation:
      "Enable continuous monitoring to track new vulnerabilities in real time.",
    upgradeComparison: {
      oneTimeScan: true,
      continuousMonitoring: true,
      historicalTracking: false,
      realTimeAlerts: false,
    },
  };
}

/* =========================================================
   GET SCAN
========================================================= */

function getScan(scanId) {
  const db = readDb();
  return db.scans.find((s) => s.id === scanId);
}

module.exports = {
  createScan,
  markScanPaid,
  processScan,
  getScan,
  TOOL_REGISTRY,
};
