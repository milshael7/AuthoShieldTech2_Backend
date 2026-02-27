require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { ensureDb, readDb, updateDb } = require("./lib/db");
const { verifyAuditIntegrity, writeAudit } = require("./lib/audit");
const { verify } = require("./lib/jwt");
const sessionAdapter = require("./lib/sessionAdapter");

const { classifyDeviceRisk } = require("./lib/deviceFingerprint");

const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");
const zeroTrust = require("./middleware/zeroTrust");

/* ================= SAFE BOOT ================= */

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[BOOT] Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv("JWT_SECRET");
requireEnv("STRIPE_SECRET_KEY");

ensureDb();
users.ensureAdminFromEnv();

/* ================= INTEGRITY ================= */

const integrityCheck = verifyAuditIntegrity();
let globalSecurityStatus = integrityCheck.ok ? "secure" : "compromised";

if (!integrityCheck.ok) {
  console.error("🚨 AUDIT INTEGRITY FAILURE ON BOOT", integrityCheck);
}

/* ================= EXPRESS ================= */

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use(rateLimiter);

/* ================= HEALTH ================= */

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    systemState: {
      status: "operational",
      securityStatus: globalSecurityStatus,
      uptime: process.uptime(),
      timestamp: Date.now(),
    },
  });
});

app.get("/live", (_, res) => res.json({ ok: true }));
app.get("/ready", (_, res) => res.json({ ready: true }));

/* ================= ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));

app.use(tenantMiddleware);

/* 🔥 ZERO TRUST APPLIED GLOBALLY AFTER AUTH */
app.use("/api", zeroTrust);

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/tools", require("./routes/tools.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/autoprotect", require("./routes/autoprotect.routes"));

/* 🔥 MISSING ROUTES ADDED */
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/users", require("./routes/users.routes"));

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

function wsClose(ws, code = 1008) {
  try {
    ws.close(code);
  } catch {}
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function isInactiveStatus(v) {
  const s = norm(v);
  return s === "locked" || s === "past due" || s === "past_due";
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return wsClose(ws, 1008);

    const payload = verify(token, "access");

    // Must have jti and not be revoked
    if (!payload?.id || !payload?.jti || sessionAdapter.isRevoked(payload.jti)) {
      return wsClose(ws, 1008);
    }

    const db = readDb();
    const user = (db.users || []).find((u) => u.id === payload.id);
    if (!user) return wsClose(ws, 1008);

    // TokenVersion sync
    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws, 1008);
    }

    // Role tamper protection
    if (norm(payload.role) !== norm(user.role)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws, 1008);
    }

    // Approval + account lock (match auth middleware intent)
    if (user.locked === true) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws, 1008);
    }

    if (user.status !== users.APPROVAL_STATUS.APPROVED) {
      return wsClose(ws, 1008);
    }

    // Subscription enforcement (user)
    if (isInactiveStatus(user.subscriptionStatus)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws, 1008);
    }

    // Company enforcement (if bound)
    if (user.companyId) {
      const company = (db.companies || []).find(
        (c) => String(c.id) === String(user.companyId)
      );

      if (!company) return wsClose(ws, 1008);

      if (company.status === "Suspended") {
        sessionAdapter.revokeToken(payload.jti);
        return wsClose(ws, 1008);
      }

      if (isInactiveStatus(company.subscriptionStatus)) {
        sessionAdapter.revokeToken(payload.jti);
        return wsClose(ws, 1008);
      }
    }

    // Device binding enforcement
    const deviceRisk = classifyDeviceRisk(user.activeDeviceFingerprint, req);
    if (!deviceRisk.match) {
      sessionAdapter.revokeAllUserSessions(user.id);
      return wsClose(ws, 1008);
    }

    // Register session (pass TTL if your store supports it)
    const ttlMs = 15 * 60 * 1000; // match access token lifetime (15m)
    sessionAdapter.registerSession(user.id, payload.jti, ttlMs);

    ws.user = {
      id: user.id,
      role: user.role,
      companyId: user.companyId || null,
      jti: payload.jti,
    };
  } catch {
    wsClose(ws, 1008);
  }
});

/* ================= AUTO TERMINATE REVOKED ================= */

setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (!client.user?.jti) return;

    if (sessionAdapter.isRevoked(client.user.jti)) {
      try {
        client.close(1008);
      } catch {}
    }
  });
}, 10000);

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
