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

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  })
);

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

/* ================= SECURITY EVENT BROADCAST ================= */

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

app.set("broadcastSecurityEvent", broadcastSecurityEvent);

/* =========================================================
   🔥 AI ANOMALY ENGINE
========================================================= */

/*
  This engine runs every 15 seconds.
  It analyzes the last 5 minutes of activity.
  It compares spike intensity and clustering.
*/

const WINDOW_MS = 5 * 60 * 1000;
const CHECK_INTERVAL = 15000;
const anomalyMemory = new Map(); // prevent duplicate spam

function detectAnomalies() {
  const db = readDb();
  const events = db.securityEvents || [];

  const now = Date.now();
  const recent = events.filter(
    e => new Date(e.timestamp || e.createdAt).getTime() >= now - WINDOW_MS
  );

  const byCompany = {};

  for (const e of recent) {
    const cid = e.companyId || "global";
    if (!byCompany[cid]) byCompany[cid] = [];
    byCompany[cid].push(e);
  }

  for (const [companyId, list] of Object.entries(byCompany)) {
    const critical = list.filter(e => e.severity === "critical").length;
    const high = list.filter(e => e.severity === "high").length;
    const total = list.length;

    const baseline = (events.length / 24) || 1; // rough baseline
    const spikeFactor = total / baseline;

    let trigger = false;
    let reason = "";

    if (critical >= 3) {
      trigger = true;
      reason = "Multiple critical events detected in short window.";
    }

    if (spikeFactor > 5 && total > 10) {
      trigger = true;
      reason = "Abnormal spike in security activity detected.";
    }

    const memoryKey = `${companyId}-${reason}`;

    if (trigger && !anomalyMemory.has(memoryKey)) {
      anomalyMemory.set(memoryKey, Date.now());

      const anomalyEvent = {
        id: `anomaly-${Date.now()}`,
        title: "AI Anomaly Detected",
        description: reason,
        severity: "critical",
        companyId: companyId === "global" ? null : companyId,
        timestamp: new Date().toISOString(),
        aiGenerated: true,
      };

      db.securityEvents.push(anomalyEvent);
      writeDb(db);

      broadcastSecurityEvent(anomalyEvent);

      console.log("[AI] Anomaly triggered:", reason);
    }
  }

  // expire memory after 10 minutes
  for (const [key, ts] of anomalyMemory.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      anomalyMemory.delete(key);
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
