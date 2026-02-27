require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");

const { ensureDb, readDb } = require("./lib/db");
const { verifyAuditIntegrity } = require("./lib/audit");
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
requireEnv("STRIPE_WEBHOOK_SECRET");

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

/* =========================================================
   🔥 STRIPE WEBHOOK BEFORE JSON PARSER
========================================================= */

app.use(
  "/api/stripe/webhook",
  require("./routes/stripe.webhook.routes")
);

/* ================= CORE MIDDLEWARE ================= */

const allowedOrigin = process.env.CORS_ORIGIN;

app.use(cors({
  origin: allowedOrigin ? allowedOrigin : false,
  credentials: true
}));

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

/* Auth intentionally before tenant + zeroTrust */
app.use("/api/auth", require("./routes/auth.routes"));

/* Tenant boundary must apply before ZeroTrust */
app.use(tenantMiddleware);

/* ZeroTrust applies to ALL /api except auth */
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return zeroTrust(req, res, next);
});

/* API ROUTES */
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/tools", require("./routes/tools.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/autoprotect", require("./routes/autoprotect.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/users", require("./routes/users.routes"));

/* ================= 404 HANDLER ================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found"
  });
});

/* ================= GLOBAL ERROR HANDLER ================= */

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

function wsClose(ws, code = 1008) {
  try { ws.close(code); } catch {}
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
    if (!token) return wsClose(ws);

    const payload = verify(token, "access");
    if (!payload?.id || !payload?.jti) return wsClose(ws);

    if (sessionAdapter.isRevoked(payload.jti)) return wsClose(ws);

    const db = readDb();
    const user = (db.users || []).find(
      (u) => String(u.id) === String(payload.id)
    );
    if (!user) return wsClose(ws);

    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    if (norm(payload.role) !== norm(user.role)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    if (user.locked === true) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    if (user.status !== users.APPROVAL_STATUS.APPROVED) {
      return wsClose(ws);
    }

    if (isInactiveStatus(user.subscriptionStatus)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    if (user.companyId) {
      const company = (db.companies || []).find(
        (c) => String(c.id) === String(user.companyId)
      );

      if (!company) return wsClose(ws);

      if (company.status === "Suspended") {
        sessionAdapter.revokeToken(payload.jti);
        return wsClose(ws);
      }

      if (isInactiveStatus(company.subscriptionStatus)) {
        sessionAdapter.revokeToken(payload.jti);
        return wsClose(ws);
      }
    }

    /* Strict device binding */
    const deviceRisk = classifyDeviceRisk(user.activeDeviceFingerprint, req);
    if (!deviceRisk?.match) {
      sessionAdapter.revokeAllUserSessions(user.id);
      return wsClose(ws);
    }

    /* Register session */
    const ttlMs = 15 * 60 * 1000;
    sessionAdapter.registerSession(user.id, payload.jti, ttlMs);

    ws.user = {
      id: user.id,
      role: user.role,
      companyId: user.companyId || null,
      jti: payload.jti,
    };

  } catch {
    wsClose(ws);
  }
});

/* ================= AUTO TERMINATE REVOKED ================= */

setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (!client.user?.jti) return;

    if (sessionAdapter.isRevoked(client.user.jti)) {
      try { client.close(1008); } catch {}
    }
  });
}, 10000);

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
