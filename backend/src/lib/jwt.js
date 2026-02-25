// backend/src/lib/jwt.js
// Enterprise JWT Core — Rotation Ready v2
// Key Rotation • Strict Claims • Multi-Key Verify • Replay Foundation

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/* =========================================================
   CONFIG
========================================================= */

const ACTIVE_SECRET = process.env.JWT_SECRET;
const PREVIOUS_SECRET = process.env.JWT_SECRET_PREVIOUS || null;

const JWT_ISSUER = process.env.JWT_ISSUER || "autoshield-tech";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "autoshield-clients";

const JWT_ALGORITHM = "HS256";
const MAX_ACCESS_LIFETIME = 60 * 60 * 24; // 24 hours max

if (!ACTIVE_SECRET || ACTIVE_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 chars");
}

/* =========================================================
   SIGN BASE
========================================================= */

function baseSign(payload, { expiresIn, type }) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JWT payload");
  }

  if (!type) {
    throw new Error("JWT type required");
  }

  const jti = crypto.randomUUID();

  const token = jwt.sign(
    {
      ...payload,
      type,
      jti,
    },
    ACTIVE_SECRET,
    {
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      header: {
        kid: "active",
      },
    }
  );

  return token;
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
   BACKWARD COMPAT SIGN
========================================================= */

function sign(payload, _ignoredSecret, expiresIn = "15m") {
  return signAccess(payload, expiresIn);
}

/* =========================================================
   VERIFY
========================================================= */

function tryVerify(token, secret) {
  return jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
    clockTolerance: 5,
  });
}

function verify(token, expectedType = "access") {
  if (!token || typeof token !== "string") {
    throw new Error("Invalid token");
  }

  let decoded;

  try {
    decoded = tryVerify(token, ACTIVE_SECRET);
  } catch (err) {
    if (!PREVIOUS_SECRET) throw err;

    try {
      decoded = tryVerify(token, PREVIOUS_SECRET);
    } catch {
      throw err;
    }
  }

  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid token payload");
  }

  if (decoded.type !== expectedType) {
    throw new Error("Invalid token type");
  }

  if (!decoded.id || !decoded.role) {
    throw new Error("Malformed token payload");
  }

  /* =========================================================
     ABSOLUTE LIFETIME ENFORCEMENT
  ========================================================= */

  if (decoded.iat && decoded.exp) {
    const lifetime = decoded.exp - decoded.iat;
    if (lifetime > MAX_ACCESS_LIFETIME && expectedType === "access") {
      throw new Error("Token lifetime exceeds policy");
    }
  }

  return decoded;
}

module.exports = {
  sign,
  signAccess,
  signRefresh,
  verify,
};
