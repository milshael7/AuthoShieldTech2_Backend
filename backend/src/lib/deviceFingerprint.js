// backend/src/lib/deviceFingerprint.js
// Enterprise Device Binding Engine
// Stateless Fingerprint • Session Binding • Hijack Detection Ready

const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const FP_VERSION = 1;
const HASH_ALGO = "sha256";

/* =========================================================
   UTIL
========================================================= */

function sha256(input) {
  return crypto
    .createHash(HASH_ALGO)
    .update(String(input))
    .digest("hex");
}

function normalize(str, max = 500) {
  return String(str || "")
    .trim()
    .slice(0, max);
}

/* =========================================================
   BUILD DEVICE FINGERPRINT
========================================================= */

/**
 * Builds deterministic fingerprint from request
 * Does NOT store raw UA/IP to preserve privacy.
 */
function buildFingerprint(req) {
  const ua = normalize(req.headers["user-agent"], 500);
  const accept = normalize(req.headers["accept"], 300);
  const lang = normalize(req.headers["accept-language"], 100);
  const encoding = normalize(req.headers["accept-encoding"], 100);

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "";

  const raw = [
    FP_VERSION,
    ua,
    accept,
    lang,
    encoding,
    ip
  ].join("|");

  return sha256(raw);
}

/* =========================================================
   VERIFY DEVICE MATCH
========================================================= */

/**
 * Returns:
 *  - true  (exact match)
 *  - false (mismatch)
 */
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
      risk: "unknown"
    };
  }

  const current = buildFingerprint(req);

  if (current === storedFingerprint) {
    return {
      match: true,
      risk: "low"
    };
  }

  return {
    match: false,
    risk: "high"
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  buildFingerprint,
  isDeviceMatch,
  classifyDeviceRisk,
  FP_VERSION
};
