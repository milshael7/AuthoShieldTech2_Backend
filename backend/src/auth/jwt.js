const jwt = require("jsonwebtoken");

/**
 * Sign a JWT
 * - Default expiration: 7 days
 */
const sign = (payload, secret = process.env.JWT_SECRET, expiresIn = "7d") => {
  if (!secret) {
    throw new Error("JWT_SECRET is not defined");
  }

  return jwt.sign(payload, secret, { expiresIn });
};

/**
 * Verify a JWT
 * - Uses JWT_SECRET by default
 * - Adds clock tolerance to prevent refresh failures
 */
const verify = (token, secret = process.env.JWT_SECRET) => {
  if (!secret) {
    throw new Error("JWT_SECRET is not defined");
  }

  return jwt.verify(token, secret, {
    clockTolerance: 5, // ⏱ allows small clock drift (VERY IMPORTANT)
  });
};

module.exports = { sign, verify };
