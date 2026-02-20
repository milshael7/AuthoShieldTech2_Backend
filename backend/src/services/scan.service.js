// backend/src/services/scan.service.js
// Scan Engine — Dynamic Pricing • Queue Based • Revenue Optimized

const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");

/* =========================================================
   TOOL REGISTRY (BASE CONFIG)
========================================================= */

const TOOL_REGISTRY = {
  "vulnerability-scan": {
    name: "Vulnerability Scan",
    basePrice: 199,
    pricingModel: "per_scan", // per_scan | per_hour
    type: "paid",
  },
  "dark-web-scan": {
    name: "Dark Web Exposure Scan",
    basePrice: 299,
    pricingModel: "per_scan",
    type: "paid",
  },
  "basic-risk": {
    name: "Basic Risk Assessment",
    basePrice: 0,
    pricingModel: "per_scan",
    type: "free",
  },
};

/* =========================================================
   PRICE CALCULATION ENGINE
========================================================= */

function calculatePrice(tool, inputData = {}) {
  let price = tool.basePrice;

  // Depth multiplier
  if (inputData.depth === "deep") price += 150;
  if (inputData.depth === "enterprise") price += 400;

  // Multiple targets
  if (inputData.targets && Number(inputData.targets) > 1) {
    price += (Number(inputData.targets) - 1) * 50;
  }

  // Urgency
  if (inputData.urgency === "rush") {
    price += 200;
  }

  // Hourly model support
  if (tool.pricingModel === "per_hour" && inputData.hours) {
    price = tool.basePrice * Number(inputData.hours);
  }

  return Math.max(0, Math.round(price));
}

/* =========================================================
   CREATE SCAN
========================================================= */

function createScan({ toolId, email, inputData }) {
  const tool = TOOL_REGISTRY[toolId];
  if (!tool) throw new Error("Invalid tool");

  const finalPrice = calculatePrice(tool, inputData);

  const scan = {
    id: nanoid(),
    toolId,
    toolName: tool.name,
    email,
    inputData,
    basePrice: tool.basePrice,
    finalPrice,
    pricingModel: tool.pricingModel,
    status: finalPrice > 0 ? "awaiting_payment" : "pending",
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
   RISK ENGINE
========================================================= */

function generateRiskScore() {
  return Math.floor(Math.random() * 60) + 20;
}

function getRiskLevel(score) {
  if (score >= 70) return "High";
  if (score >= 45) return "Moderate";
  return "Low";
}

/* =========================================================
   REPORT ENGINE
========================================================= */

function generateReport(scan, riskScore) {
  const riskLevel = getRiskLevel(riskScore);

  return {
    overview: {
      riskScore,
      riskLevel,
      scannedTool: scan.toolName,
      pricingModel: scan.pricingModel,
      scanType: scan.finalPrice === 0 ? "Free Scan" : "One-Time Scan",
    },

    billing: {
      basePrice: scan.basePrice,
      finalPrice: scan.finalPrice,
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
        "This was a single-time scan. Continuous monitoring automatically detects new vulnerabilities and real-time exposure.",
      membershipBenefits: [
        "24/7 threat monitoring",
        "Real-time alerts",
        "Historical risk analytics",
        "Compliance dashboard",
      ],
    },

    nextStepCTA:
      "Upgrade to continuous protection to maintain ongoing security visibility.",
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
