// backend/src/lib/jwt.js
// AutoShield — Enterprise JWT Core (Hardened)

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || "autoshield-tech";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "autoshield-clients";
const JWT_ALGORITHM = "HS256";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined");
}

/* =========================================================
   ACCESS TOKEN (Short-lived)
   ========================================================= */

function signAccess(payload, expiresIn = "15m") {
  const jti = crypto.randomUUID();

  return jwt.sign(
    {
      ...payload,
      type: "access",
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
   REFRESH TOKEN (Long-lived)
   ========================================================= */

function signRefresh(payload, expiresIn = "7d") {
  const jti = crypto.randomUUID();

  return jwt.sign(
    {
      ...payload,
      type: "refresh",
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
   VERIFY TOKEN
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
  signAccess,
  signRefresh,
  verify,
};
