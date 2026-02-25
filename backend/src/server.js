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
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");

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

/* ================= STARTUP INTEGRITY CHECK ================= */

const integrityCheck = verifyAuditIntegrity();
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
app.use(rateLimiter); // 🔐 Global traffic shield

/* ================= HEALTH ================= */

let globalSecurityStatus = integrityCheck.ok ? "secure" : "compromised";

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    systemState: {
      status: "operational",
      securityStatus: globalSecurityStatus,
      uptime: process.uptime(),
      timestamp: Date.now()
    }
  });
});

/* Liveness (for load balancers) */
app.get("/live", (req, res) => {
  res.status(200).json({ ok: true });
});

/* Readiness (future DB/redis checks go here) */
app.get("/ready", (req, res) => {
  res.status(200).json({ ready: true });
});

/* ================= ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));
app.use(tenantMiddleware);

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/tools", require("./routes/tools.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/autoprotect", require("./routes/autoprotect.routes"));

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET (HARDENED) ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return ws.close(1008);

    const payload = verify(token, "access");

    const db = readDb();
    const user = (db.users || []).find(u => u.id === payload.id);
    if (!user) return ws.close(1008);

    /* ===== TOKEN VERSION ENFORCEMENT ===== */
    if ((payload.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      writeAudit({
        actor: user.id,
        role: user.role,
        action: "WS_TOKEN_VERSION_MISMATCH"
      });
      return ws.close(1008);
    }

    /* ===== ACCOUNT LOCK ===== */
    if (user.locked) return ws.close(1008);

    /* ===== SUBSCRIPTION CHECK ===== */
    const inactive =
      user.subscriptionStatus === users.SUBSCRIPTION.LOCKED ||
      user.subscriptionStatus === users.SUBSCRIPTION.PAST_DUE;

    if (inactive) return ws.close(1008);

    /* ===== COMPANY CHECK ===== */
    if (user.companyId) {
      const company = (db.companies || []).find(
        c => c.id === user.companyId
      );
      if (!company || company.status === "Suspended") {
        return ws.close(1008);
      }
    }

    ws.user = {
      id: user.id,
      role: user.role,
      companyId: user.companyId || null,
    };

    if (["Admin", "Finance"].includes(user.role)) {
      writeAudit({
        actor: user.id,
        role: user.role,
        action: "WS_HIGH_PRIVILEGE_CONNECTION"
      });
    }

  } catch {
    ws.close(1008);
  }
});

/* ================= BROADCAST CORE ================= */

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

/* ================= INTELLIGENCE ENGINE ================= */

const WINDOW_MS = 5 * 60 * 1000;
const CHECK_INTERVAL = 15000;
const baselineMemory = new Map();

function detectIntelligence() {
  const db = readDb();
  const events = db.securityEvents || [];
  const now = Date.now();

  const recent = events.filter(
    e => new Date(e.timestamp || e.createdAt).getTime() >= now - WINDOW_MS
  );

  const grouped = {};

  for (const e of recent) {
    const cid = e.companyId || "global";
    if (!grouped[cid]) grouped[cid] = [];
    grouped[cid].push(e);
  }

  for (const [companyId, list] of Object.entries(grouped)) {

    const assetExposure = {};

    list.forEach(e => {
      const asset = e.targetAsset || "unknown";
      const weight =
        e.severity === "critical" ? 25 :
        e.severity === "high" ? 15 :
        e.severity === "medium" ? 8 : 2;

      assetExposure[asset] =
        (assetExposure[asset] || 0) + weight;
    });

    broadcast({ type: "asset_exposure_update", companyId, exposure: assetExposure });

    const total = list.length;
    const critical = list.filter(e => e.severity === "critical").length;
    const criticalRatio = total > 0 ? critical / total : 0;

    if (!baselineMemory.has(companyId)) {
      baselineMemory.set(companyId, {
        avgWindowCount: total || 1,
        avgCriticalRatio: criticalRatio,
        riskScore: 10,
      });
    }

    const baseline = baselineMemory.get(companyId);

    baseline.avgWindowCount =
      baseline.avgWindowCount * 0.95 + total * 0.05;

    baseline.avgCriticalRatio =
      baseline.avgCriticalRatio * 0.95 + criticalRatio * 0.05;

    const volumeDeviation =
      total / (baseline.avgWindowCount || 1);

    const criticalDeviation =
      criticalRatio / (baseline.avgCriticalRatio || 0.01);

    let risk =
      Math.min(
        100,
        Math.round(
          baseline.riskScore +
          (volumeDeviation * 5) +
          (criticalDeviation * 10)
        )
      );

    if (risk < 5) risk = 5;
    baseline.riskScore = risk;

    broadcast({ type: "risk_update", companyId, riskScore: risk });
  }
}

setInterval(detectIntelligence, CHECK_INTERVAL);

/* ================= AUDIT INTEGRITY WATCHDOG ================= */

const INTEGRITY_CHECK_INTERVAL = 60000;
let integrityCompromised = false;

function monitorAuditIntegrity() {
  const result = verifyAuditIntegrity();

  if (!result.ok && !integrityCompromised) {

    integrityCompromised = true;
    globalSecurityStatus = "compromised";

    writeAudit({
      actor: "integrity_watchdog",
      role: "system",
      action: "AUDIT_INTEGRITY_FAILURE",
      detail: result,
    });

    updateDb((db) => {
      if (!Array.isArray(db.securityEvents))
        db.securityEvents = [];

      db.securityEvents.push({
        id: crypto.randomUUID(),
        severity: "critical",
        timestamp: Date.now(),
        message: "Audit ledger integrity failure detected",
        type: "ledger_integrity",
      });

      return db;
    });

    broadcast({
      type: "integrity_alert",
      severity: "critical",
      detail: result,
    });

    console.error("🚨 AUDIT INTEGRITY FAILURE DETECTED", result);
  }
}

setInterval(monitorAuditIntegrity, INTEGRITY_CHECK_INTERVAL);

/* ================= GRACEFUL SHUTDOWN ================= */

function shutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}`);
  server.close(() => {
    console.log("[SHUTDOWN] HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[SHUTDOWN] Forced exit");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
  writeAudit({
    actor: "system",
    role: "system",
    action: "UNHANDLED_REJECTION",
    detail: { message: err?.message }
  });
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  writeAudit({
    actor: "system",
    role: "system",
    action: "UNCAUGHT_EXCEPTION",
    detail: { message: err?.message }
  });
});

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
