require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");

const { ensureDb, readDb, writeDb } = require("./lib/db");
const { verifyAuditIntegrity, writeAudit } = require("./lib/audit");
const { verify } = require("./lib/jwt");
const sessionAdapter = require("./lib/sessionAdapter");
const { classifyDeviceRisk } = require("./lib/deviceFingerprint");
const { verifyRevenueLedger } = require("./lib/revenueIntegrity");

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

const auditIntegrity = verifyAuditIntegrity();
let globalSecurityStatus = auditIntegrity.ok ? "secure" : "compromised";

const revenueIntegrity = verifyRevenueLedger();
let financialStatus = revenueIntegrity.ok ? "secure" : "compromised";

if (!auditIntegrity.ok) {
  console.error("🚨 AUDIT INTEGRITY FAILURE", auditIntegrity);
}

if (!revenueIntegrity.ok) {
  console.error("🚨 REVENUE LEDGER CORRUPTION", revenueIntegrity);
}

/* ================= EXPRESS ================= */

const app = express();
app.set("trust proxy", 1);

app.use(
  "/api/stripe/webhook",
  require("./routes/stripe.webhook.routes")
);

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
      financialStatus,
      uptime: process.uptime(),
      timestamp: Date.now(),
    },
  });
});

/* ================= ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));
app.use(tenantMiddleware);

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return zeroTrust(req, res, next);
});

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/tools", require("./routes/tools.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/autoprotect", require("./routes/autoprotect.routes"));
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
  try { ws.close(code); } catch {}
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function isInactiveStatus(v) {
  const s = norm(v);
  return s === "locked" || s === "past_due" || s === "past due";
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

    /* ===== TOKEN VERSION ===== */

    const tokenVersion = Number(payload.tokenVersion || 0);
    const currentVersion = Number(user.tokenVersion || 0);

    if (tokenVersion !== currentVersion) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    /* ===== ACCOUNT LOCK ===== */

    if (user.locked === true) {
      return wsClose(ws);
    }

    if (user.status !== users.APPROVAL_STATUS.APPROVED) {
      return wsClose(ws);
    }

    /* ===== SUBSCRIPTION ===== */

    if (isInactiveStatus(user.subscriptionStatus)) {
      return wsClose(ws);
    }

    /* ===== COMPANY STATUS ===== */

    if (user.companyId) {
      const company = (db.companies || []).find(
        c => String(c.id) === String(user.companyId)
      );

      if (!company || company.status === "Locked") {
        sessionAdapter.revokeAllUserSessions(user.id);
        return wsClose(ws);
      }
    }

    /* ===== DEVICE BINDING ===== */

    const deviceCheck = classifyDeviceRisk(
      user.activeDeviceFingerprint,
      req
    );

    if (!deviceCheck.match) {
      sessionAdapter.revokeAllUserSessions(user.id);
      return wsClose(ws);
    }

    /* ===== REGISTER SESSION ===== */

    const ttlMs = 15 * 60 * 1000;
    sessionAdapter.registerSession(user.id, payload.jti, ttlMs);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "WEBSOCKET_CONNECTED",
      detail: {
        path: req.url,
        companyId: user.companyId || null
      }
    });

    ws.user = {
      id: user.id,
      role: user.role,
      companyId: user.companyId || null,
      jti: payload.jti,
    };

  } catch (err) {
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
