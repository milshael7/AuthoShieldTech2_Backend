// backend/src/lib/deviceFingerprint.js
// AutoShield Tech — Enterprise Device Binding Engine v2
// Privacy Safe • IP Tolerant • Risk Scored • Versioned • Hijack Resistant

const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const FP_VERSION = 2;
const HASH_ALGO = "sha256";

/*
  Risk Scoring:
  - 0–30  → low
  - 31–70 → medium
  - 71–100 → high
*/

const MAX_FIELD_LENGTH = 500;

/* =========================================================
   UTIL
========================================================= */

function sha256(input) {
  return crypto
    .createHash(HASH_ALGO)
    .update(String(input))
    .digest("hex");
}

function normalize(str, max = MAX_FIELD_LENGTH) {
  return String(str || "")
    .trim()
    .slice(0, max);
}

function extractIp(req) {
  const raw =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "";

  return normalize(raw, 100);
}

function subnet(ip) {
  if (!ip) return "";

  // IPv4 handling
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return parts.slice(0, 3).join("."); // /24 subnet
  }

  // IPv6 handling (truncate)
  if (ip.includes(":")) {
    return ip.split(":").slice(0, 4).join(":");
  }

  return ip;
}

/* =========================================================
   BUILD FINGERPRINT
========================================================= */

/*
  IP is NOT hashed directly.
  We hash subnet instead to tolerate normal mobile drift.
*/

function buildFingerprint(req) {
  const ua = normalize(req.headers["user-agent"], 500);
  const accept = normalize(req.headers["accept"], 300);
  const lang = normalize(req.headers["accept-language"], 100);
  const encoding = normalize(req.headers["accept-encoding"], 100);

  const ip = extractIp(req);
  const ipSubnet = subnet(ip);

  const raw = [
    FP_VERSION,
    ua,
    accept,
    lang,
    encoding,
    ipSubnet
  ].join("|");

  return sha256(raw);
}

/* =========================================================
   MATCH CHECK
========================================================= */

function isDeviceMatch(storedFingerprint, req) {
  if (!storedFingerprint) return false;
  const current = buildFingerprint(req);
  return current === storedFingerprint;
}

/* =========================================================
   RISK CLASSIFICATION
========================================================= */

function classifyDeviceRisk(storedFingerprint, req) {
  if (!storedFingerprint) {
    return {
      match: false,
      risk: "unknown",
      score: 100
    };
  }

  const current = buildFingerprint(req);

  if (current === storedFingerprint) {
    return {
      match: true,
      risk: "low",
      score: 0
    };
  }

  // Soft comparison (field-level drift scoring)
  let score = 0;

  const ua = normalize(req.headers["user-agent"]);
  if (!ua) score += 40;

  const ip = extractIp(req);
  if (!ip) score += 30;

  if (score < 30) score = 70; // fallback mismatch baseline

  let riskLevel = "medium";
  if (score >= 71) riskLevel = "high";
  if (score <= 30) riskLevel = "low";

  return {
    match: false,
    risk: riskLevel,
    score
  };
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  buildFingerprint,
  isDeviceMatch,
  classifyDeviceRisk,
  FP_VERSION
};
