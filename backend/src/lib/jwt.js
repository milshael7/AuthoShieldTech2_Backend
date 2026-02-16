// backend/lib/jwt.js
// Unified JWT Core for AutoShield

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || "autoshield-tech";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "autoshield-clients";
const JWT_ALGORITHM = "HS256";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined");
}

/* =========================================================
   BASE SIGNER
========================================================= */

function baseSign(payload, { expiresIn, type }) {
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
   BACKWARD COMPATIBLE SIGN
========================================================= */

function sign(payload, _secretIgnored, expiresIn = "7d") {
  return signAccess(payload, expiresIn);
}

/* =========================================================
   VERIFY
========================================================= */

function verify(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
    clockTolerance: 5,
  });
}

module.exports = {
  sign,
  signAccess,
  signRefresh,
  verify,
};
