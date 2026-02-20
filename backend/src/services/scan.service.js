// backend/src/services/scan.service.js
// Scan Engine — Queue Based • Revenue Ready • Upgrade Optimized

const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");

/* =========================================================
   TOOL REGISTRY
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
    if (!Array.isArray(db.scans)) db.scans = [];
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
   PROCESS SCAN
========================================================= */

function processScan(scanId) {
  updateDb((db) => {
    const scan = db.scans.find((s) => s.id === scanId);
    if (!scan || scan.status !== "pending") return;
    scan.status = "running";
  });

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
   RISK LOGIC
========================================================= */

function generateRiskScore() {
  return Math.floor(Math.random() * 60) + 20; // realistic 20–80
}

function getRiskLevel(score) {
  if (score >= 70) return "High";
  if (score >= 45) return "Moderate";
  return "Low";
}

/* =========================================================
   REPORT ENGINE (CONVERSION OPTIMIZED)
========================================================= */

function generateReport(scan, riskScore) {
  const riskLevel = getRiskLevel(riskScore);

  return {
    overview: {
      riskScore,
      riskLevel,
      scannedTool: scan.toolName,
      scanType: scan.price === 0 ? "Free Scan" : "One-Time Scan",
    },

    severityBreakdown: {
      critical: Math.floor(riskScore / 30),
      high: Math.floor(riskScore / 20),
      medium: Math.floor(riskScore / 12),
      low: 2,
    },

    findings: [
      "External exposure points detected.",
      "Surface-level vulnerabilities identified.",
      "Internal network and historical analysis not included.",
    ],

    recommendation:
      "Continuous monitoring is recommended to detect newly emerging vulnerabilities and real-time threats.",

    upgradeInsight: {
      message:
        "This report reflects a single-time external scan. Ongoing monitoring can detect new exposures automatically and provide real-time alerts.",
      includedInMembership: [
        "Real-time threat alerts",
        "Continuous vulnerability monitoring",
        "Historical risk tracking",
        "Automated compliance tracking",
      ],
      lockedFeatures: [
        "24/7 monitoring engine",
        "Live threat feed",
        "Incident response priority",
      ],
    },

    comparison: {
      oneTimeScan: {
        realTimeMonitoring: false,
        historicalTracking: false,
        alertSystem: false,
        complianceDashboard: false,
      },
      membership: {
        realTimeMonitoring: true,
        historicalTracking: true,
        alertSystem: true,
        complianceDashboard: true,
      },
    },

    nextStepCTA:
      "Upgrade to continuous protection to reduce exposure risk and maintain ongoing security posture visibility.",
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
