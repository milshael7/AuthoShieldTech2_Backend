require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");

const { ensureDb, readDb, writeDb } = require("./lib/db");
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");

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

/* ================= EXPRESS ================= */

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

/* ================= ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));
app.use(tenantMiddleware);
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return ws.close(1008);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    ws.user = {
      id: decoded.id,
      role: decoded.role,
      companyId: decoded.companyId || null,
    };
  } catch {
    ws.close(1008);
  }
});

/* ================= BROADCAST ================= */

function broadcast(payload, filterFn = null) {
  const msg = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (filterFn && !filterFn(client)) return;
    try { client.send(msg); } catch {}
  });
}

/* ================= BROADCAST HELPERS ================= */

function broadcastSecurityEvent(event) {
  broadcast(
    { type: "security_event", event },
    (client) => {
      if (client.user?.role === "Admin") return true;
      if (event.companyId && client.user?.companyId !== event.companyId)
        return false;
      return true;
    }
  );
}

function broadcastRiskUpdate(companyId, riskScore) {
  broadcast(
    { type: "risk_update", companyId, riskScore },
    (client) => {
      if (client.user?.role === "Admin") return true;
      if (client.user?.companyId !== companyId) return false;
      return true;
    }
  );
}

function broadcastAIAction(action) {
  broadcast({ type: "ai_action", action }, () => true);
}

app.set("broadcastSecurityEvent", broadcastSecurityEvent);

/* =========================================================
   🔥 ADAPTIVE AI + AUTO RESPONSE ENGINE
========================================================= */

const WINDOW_MS = 5 * 60 * 1000;
const CHECK_INTERVAL = 15000;

const anomalyMemory = new Map();
const baselineMemory = new Map();
const autoResponseMemory = new Map();

/* ===== AI AUDIT LOGGER ===== */

function logAIAction(db, action) {
  if (!db.audit) db.audit = [];

  db.audit.push({
    id: `ai-action-${Date.now()}`,
    type: "AI_AUTOMATED_ACTION",
    actor: "AI_ENGINE",
    action: action.type,
    companyId: action.companyId || null,
    details: action,
    timestamp: new Date().toISOString(),
  });
}

function detectAnomalies() {
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

    broadcastRiskUpdate(companyId, risk);

    /* ================= AUTO RESPONSE ================= */

    const autoKey = `${companyId}-risk-${Math.floor(risk / 10)}`;

    if (risk >= 85 && !autoResponseMemory.has(autoKey)) {
      autoResponseMemory.set(autoKey, now);

      const action = {
        id: `ai-containment-${Date.now()}`,
        type: "AUTO_CONTAINMENT_TRIGGERED",
        companyId: companyId === "global" ? null : companyId,
        severity: "critical",
        riskScore: risk,
        message: "AI triggered automated containment due to critical risk threshold.",
        timestamp: new Date().toISOString(),
      };

      const containmentEvent = {
        id: `containment-${Date.now()}`,
        title: "AI Automated Containment Activated",
        description: action.message,
        severity: "critical",
        companyId: action.companyId,
        timestamp: action.timestamp,
        aiGenerated: true,
        automatedResponse: true,
      };

      db.securityEvents.push(containmentEvent);
      logAIAction(db, action);
      writeDb(db);

      broadcastSecurityEvent(containmentEvent);
      broadcastAIAction(action);

      console.log("[AI AUTO RESPONSE] Containment triggered.");
    }
  }

  /* Expire memory */
  for (const [key, ts] of autoResponseMemory.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      autoResponseMemory.delete(key);
    }
  }
}

setInterval(detectAnomalies, CHECK_INTERVAL);

/* =========================================================
   START
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
