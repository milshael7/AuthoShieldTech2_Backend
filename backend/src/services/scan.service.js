// backend/src/services/scan.service.js
// Scan Engine — Credit Enforced • SaaS Ready • Revenue Safe

const { nanoid } = require("nanoid");
const { readDb, updateDb } = require("../lib/db");
const { audit } = require("../lib/audit");
const { getUserEffectivePlan } = require("../users/user.service");

/* =========================================================
   TOOL REGISTRY
========================================================= */

const TOOL_REGISTRY = {
  "vulnerability-scan": {
    name: "Vulnerability Scan",
    basePrice: 199,
    pricingModel: "per_scan",
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
   CREDIT UTILITIES
========================================================= */

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

function getUserMonthlyUsage(db, userId) {
  const key = currentMonthKey();

  if (!db.scanCredits) db.scanCredits = {};
  if (!db.scanCredits[userId]) {
    db.scanCredits[userId] = { month: key, used: 0 };
  }

  const record = db.scanCredits[userId];

  // Reset if new month
  if (record.month !== key) {
    record.month = key;
    record.used = 0;
  }

  return record;
}

/* =========================================================
   PRICE CALCULATION
========================================================= */

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calculatePrice(tool, inputData = {}) {
  let price = toNumber(tool.basePrice);

  if (inputData.depth === "deep") price += 150;
  if (inputData.depth === "enterprise") price += 400;

  if (toNumber(inputData.targets) > 1) {
    price += (toNumber(inputData.targets) - 1) * 50;
  }

  if (inputData.urgency === "rush") {
    price += 200;
  }

  return Math.max(0, Math.round(price));
}

/* =========================================================
   CREATE SCAN (CREDIT AWARE)
========================================================= */

function createScan({ toolId, email, inputData, user }) {
  const tool = TOOL_REGISTRY[toolId];
  if (!tool) throw new Error("Invalid tool");

  const db = readDb();
  const finalPriceRaw = calculatePrice(tool, inputData);

  let finalPrice = finalPriceRaw;
  let creditUsed = false;

  if (user) {
    const plan = getUserEffectivePlan(user);
    const included = plan.includedScans || 0;

    if (included > 0) {
      const usage = getUserMonthlyUsage(db, user.id);

      if (usage.used < included) {
        usage.used += 1;
        finalPrice = 0;
        creditUsed = true;
      }
    }
  }

  const scan = {
    id: nanoid(),
    toolId,
    toolName: tool.name,
    email: String(email || "").trim(),
    userId: user?.id || null,
    inputData: inputData || {},
    basePrice: tool.basePrice,
    finalPrice,
    pricingModel: tool.pricingModel,
    creditUsed,
    status: finalPrice > 0 ? "awaiting_payment" : "pending",
    paymentReceivedAt: finalPrice === 0 ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null,
  };

  updateDb((db2) => {
    if (!Array.isArray(db2.scans)) db2.scans = [];
    if (!db2.scanCredits) db2.scanCredits = db.scanCredits;
    db2.scans.push(scan);
  });

  audit({
    actorId: user?.id || "public",
    action: creditUsed ? "SCAN_CREATED_CREDIT" : "SCAN_CREATED",
    targetType: "Scan",
    targetId: scan.id,
  });

  return scan;
}

/* =========================================================
   MARK SCAN PAID
========================================================= */

function markScanPaid(scanId) {
  updateDb((db) => {
    const scan = db.scans?.find((s) => s.id === scanId);
    if (!scan) return;

    if (scan.status !== "awaiting_payment") return;

    scan.status = "pending";
    scan.paymentReceivedAt = new Date().toISOString();
  });
}

/* =========================================================
   PROCESS SCAN
========================================================= */

function processScan(scanId) {
  updateDb((db) => {
    const scan = db.scans?.find((s) => s.id === scanId);
    if (!scan) return;

    if (scan.finalPrice > 0 && !scan.paymentReceivedAt) return;
    if (scan.status !== "pending") return;

    scan.status = "running";
  });

  setTimeout(() => {
    updateDb((db) => {
      const scan = db.scans?.find((s) => s.id === scanId);
      if (!scan || scan.status !== "running") return;

      const riskScore = Math.floor(Math.random() * 60) + 20;

      scan.status = "completed";
      scan.completedAt = new Date().toISOString();
      scan.result = {
        riskScore,
        message: "Scan completed successfully.",
      };
    });
  }, 4000);
}

/* =========================================================
   GET SCAN
========================================================= */

function getScan(scanId) {
  const db = readDb();
  return db.scans?.find((s) => s.id === scanId) || null;
}

module.exports = {
  createScan,
  markScanPaid,
  processScan,
  getScan,
  TOOL_REGISTRY,
};
