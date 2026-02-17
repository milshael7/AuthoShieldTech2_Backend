// backend/src/lib/jwt.js
// Unified JWT Core — Institutional Hardened (Phase 4 Lock)
// Access/Refresh separated • Type enforced • Strict verify • No algorithm drift

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || "autoshield-tech";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "autoshield-clients";
const JWT_ALGORITHM = "HS256";

if (!JWT_SECRET || typeof JWT_SECRET !== "string" || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be defined and at least 32 characters");
}

/* =========================================================
   BASE SIGNER
========================================================= */

function baseSign(payload, { expiresIn, type }) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JWT payload");
  }

  if (!type) {
    throw new Error("JWT type required");
  }

  const jti = crypto.randomUUID();

  return jwt.sign(
    {
      ...payload,
      type,
      jti,
    },
    JWT_SECRET,
    {
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
    }
  );
}

/* =========================================================
   ACCESS TOKEN
========================================================= */

function signAccess(payload, expiresIn = "15m") {
  return baseSign(payload, {
    expiresIn,
    type: "access",
  });
}

/* =========================================================
   REFRESH TOKEN
========================================================= */

function signRefresh(payload, expiresIn = "7d") {
  return baseSign(payload, {
    expiresIn,
    type: "refresh",
  });
}

/* =========================================================
   BACKWARD COMPATIBLE SIGN (ACCESS ONLY)
========================================================= */

function sign(payload, _ignoredSecret, expiresIn = "15m") {
  return signAccess(payload, expiresIn);
}

/* =========================================================
   STRICT VERIFY
========================================================= */

function verify(token, expectedType = "access") {
  if (!token || typeof token !== "string") {
    throw new Error("Invalid token");
  }

  const decoded = jwt.verify(token, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
    clockTolerance: 5,
  });

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid token payload");
  }

  if (decoded.type !== expectedType) {
    throw new Error("Invalid token type");
  }

  if (!decoded.id || !decoded.role) {
    throw new Error("Malformed token payload");
  }

  return decoded;
}

module.exports = {
  sign,
  signAccess,
  signRefresh,
  verify,
};
