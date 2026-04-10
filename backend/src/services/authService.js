// ==========================================================
// 🛡️ AUTH SERVICE — v22.1 (UNISON JWT & TENANT SYNC)
// FILE: backend/src/services/authService.js
// ==========================================================

const jwt = require("jsonwebtoken");

// 🛰️ PUSH 6.4: Environment safety for Vercel/Railway
const JWT_SECRET = process.env.JWT_SECRET || "AUTH_SHIELD_V4_SECURE_KEY_8822";
const TOKEN_EXPIRY = "24h";

/**
 * 🎫 GENERATE TOKEN
 * Used during Login/Registration to create the secure session.
 */
function generateToken(user) {
  if (!user || !user.id) return null;

  const payload = {
    id: user.id,
    email: user.email,
    role: user.role || "user",
    companyId: user.companyId || "default", // Critical for tenant isolation
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * 🔍 VERIFY TOKEN
 * Used by Middleware and Socket Controller to validate identity.
 */
async function verifyToken(token) {
  if (!token) return null;

  try {
    // Clean the token if it has "Bearer " prefix
    const cleanToken = token.startsWith("Bearer ") 
      ? token.slice(7, token.length) 
      : token;

    const decoded = jwt.verify(cleanToken, JWT_SECRET);
    
    // In a production scenario, you would optionally do a DB lookup here:
    // const user = await User.findById(decoded.id);
    
    return decoded;
  } catch (err) {
    console.warn("[AUTH]: Token Verification Failed:", err.message);
    return null;
  }
}

/**
 * 🔑 REFRESH TOKEN (Optional/Stub)
 * Keeps the session alive without re-login.
 */
function refreshToken(oldToken) {
  try {
    const decoded = jwt.decode(oldToken);
    delete decoded.iat;
    delete decoded.exp;
    return jwt.sign(decoded, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateToken,
  verifyToken,
  refreshToken,
};
