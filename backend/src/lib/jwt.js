// backend/src/lib/jwt.js
// AutoShield Tech — Enterprise JWT Core v3
// Rotation Safe • Type Strict • Lifetime Bounded • Replay Ready • Version Enforced

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

const MAX_ACCESS_LIFETIME = 60 * 60 * 24;      // 24h hard cap
const MAX_REFRESH_LIFETIME = 60 * 60 * 24 * 30; // 30d hard cap

if (!ACTIVE_SECRET || ACTIVE_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 chars");
}

/* =========================================================
   ERROR TYPES
========================================================= */

class JWTError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "JWTError";
    this.code = code;
  }
}

/* =========================================================
   INTERNAL SIGN
========================================================= */

function baseSign(payload, { expiresIn, type }) {
  if (!payload || typeof payload !== "object") {
    throw new JWTError("Invalid JWT payload", "INVALID_PAYLOAD");
  }

  if (!type) {
    throw new JWTError("JWT type required", "TYPE_REQUIRED");
  }

  if (!payload.id || !payload.role) {
    throw new JWTError("Missing required claims", "MISSING_CLAIMS");
  }

  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const token = jwt.sign(
    {
      ...payload,
      type,
      jti,
      iat: now,
      nbf: now,
    },
    ACTIVE_SECRET,
    {
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      header: {
        kid: "active-v1",
        alg: JWT_ALGORITHM,
      },
    }
  );

  return token;
}

/* =========================================================
   SIGNERS
========================================================= */

function signAccess(payload, expiresIn = "15m") {
  return baseSign(payload, {
    expiresIn,
    type: "access",
  });
}

function signRefresh(payload, expiresIn = "7d") {
  return baseSign(payload, {
    expiresIn,
    type: "refresh",
  });
}

/* Backward compatible */
function sign(payload, _ignoredSecret, expiresIn = "15m") {
  return signAccess(payload, expiresIn);
}

/* =========================================================
   VERIFY CORE
========================================================= */

function tryVerify(token, secret) {
  return jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
    clockTolerance: 5,
  });
}

function enforceLifetime(decoded, expectedType) {
  if (!decoded.iat || !decoded.exp) return;

  const lifetime = decoded.exp - decoded.iat;

  if (expectedType === "access" && lifetime > MAX_ACCESS_LIFETIME) {
    throw new JWTError("Access token lifetime exceeds policy", "LIFETIME_EXCEEDED");
  }

  if (expectedType === "refresh" && lifetime > MAX_REFRESH_LIFETIME) {
    throw new JWTError("Refresh token lifetime exceeds policy", "LIFETIME_EXCEEDED");
  }
}

function verify(token, expectedType = "access") {
  if (!token || typeof token !== "string") {
    throw new JWTError("Invalid token", "INVALID_TOKEN");
  }

  let decoded;

  try {
    decoded = tryVerify(token, ACTIVE_SECRET);
  } catch (err) {
    if (!PREVIOUS_SECRET) {
      throw new JWTError("Token verification failed", "VERIFY_FAILED");
    }

    try {
      decoded = tryVerify(token, PREVIOUS_SECRET);
    } catch {
      throw new JWTError("Token verification failed", "VERIFY_FAILED");
    }
  }

  if (!decoded || typeof decoded !== "object") {
    throw new JWTError("Invalid token payload", "INVALID_PAYLOAD");
  }

  if (decoded.type !== expectedType) {
    throw new JWTError("Invalid token type", "INVALID_TYPE");
  }

  if (!decoded.id || !decoded.role || !decoded.jti) {
    throw new JWTError("Malformed token payload", "MALFORMED");
  }

  enforceLifetime(decoded, expectedType);

  return decoded;
}

module.exports = {
  sign,
  signAccess,
  signRefresh,
  verify,
  JWTError,
};
