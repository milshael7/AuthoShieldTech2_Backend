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

/* =========================================================
   🔥 AUTONOMOUS ZEROTRUST ENGINE
========================================================= */

const ENFORCEMENT_THRESHOLD = 75;
const ZEROTRUST_INTERVAL_MS = 15000;

function calculateCompanyRisk(db, companyId) {
  const events = (db.securityEvents || []).filter(
    e => String(e.companyId) === String(companyId)
  );

  let score = 0;

  for (const e of events) {
    if (e.severity === "critical") score += 25;
    if (e.severity === "high") score += 15;
    if (e.severity === "medium") score += 8;
    if (e.severity === "low") score += 2;
    if (!e.acknowledged) score += 5;
  }

  return Math.min(100, score);
}

function autonomousZeroTrust() {
  try {
    const db = readDb();
    db.companies = db.companies || [];

    let anyCritical = false;

    for (const company of db.companies) {
      const riskScore = calculateCompanyRisk(db, company.id);

      if (riskScore >= ENFORCEMENT_THRESHOLD) {
        if (company.status !== "Locked") {
          company.status = "Locked";
          company.lockReason = "Autonomous ZeroTrust enforcement";
          company.lockedAt = new Date().toISOString();

          writeAudit({
            actor: "system",
            role: "system",
            action: "AUTO_ZEROTRUST_LOCK",
            detail: {
              companyId: company.id,
              riskScore,
              threshold: ENFORCEMENT_THRESHOLD
            }
          });

          console.log(
            `[ZEROTRUST] Company ${company.id} locked (risk=${riskScore})`
          );
        }

        anyCritical = true;
      }
    }

    globalSecurityStatus = anyCritical ? "compromised" : "secure";

    writeDb(db);

  } catch (err) {
    console.error("[ZEROTRUST ENGINE ERROR]", err);
  }
}

setInterval(autonomousZeroTrust, ZEROTRUST_INTERVAL_MS);

/* =========================================================
   📅 COMPLIANCE SNAPSHOT ENGINE
   Daily Snapshot • Audit Anchored • Retention Enforced
========================================================= */

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function calculateComplianceScore(db) {
  const vulns = db.vulnerabilities || [];

  const critical = vulns.filter(v => v.severity === "critical").length;
  const high = vulns.filter(v => v.severity === "high").length;
  const medium = vulns.filter(v => v.severity === "medium").length;

  let score = 100 - (critical * 12 + high * 7 + medium * 4);
  score = Math.max(10, Math.min(100, score));

  return {
    score,
    breakdown: { critical, high, medium }
  };
}

function calculateExecutiveRiskScore(db) {
  const events = db.securityEvents || [];

  const critical = events.filter(e => e.severity === "critical").length;
  const high = events.filter(e => e.severity === "high").length;
  const medium = events.filter(e => e.severity === "medium").length;

  const score = Math.min(
    100,
    critical * 25 + high * 12 + medium * 5
  );

  return {
    score,
    breakdown: { critical, high, medium }
  };
}

function enforceSnapshotRetention(db) {
  const retentionDays =
    db.retentionPolicy?.snapshotRetentionDays || 365 * 3;

  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

  db.complianceSnapshots = (db.complianceSnapshots || [])
    .filter(s => new Date(s.createdAt).getTime() > cutoff);

  return db;
}

function runComplianceSnapshot() {
  try {
    const db = readDb();

    const compliance = calculateComplianceScore(db);
    const executiveRisk = calculateExecutiveRiskScore(db);

    const snapshot = {
      id: `snapshot_${Date.now()}`,
      createdAt: new Date().toISOString(),
      compliance,
      executiveRisk,
      securityStatus: globalSecurityStatus
    };

    db.complianceSnapshots = db.complianceSnapshots || [];
    db.complianceSnapshots.push(snapshot);

    enforceSnapshotRetention(db);

    writeDb(db);

    writeAudit({
      actor: "system",
      role: "system",
      action: "DAILY_COMPLIANCE_SNAPSHOT",
      detail: {
        complianceScore: compliance.score,
        executiveRiskScore: executiveRisk.score
      }
    });

    console.log("[SNAPSHOT] Daily compliance snapshot stored");

  } catch (err) {
    console.error("[SNAPSHOT ERROR]", err);
  }
}

setInterval(runComplianceSnapshot, SNAPSHOT_INTERVAL_MS);

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

/* ================= 404 ================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found"
  });
});

/* ================= ERROR HANDLER ================= */

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
