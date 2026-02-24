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

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

/* ================= INTELLIGENCE ENGINE ================= */

const WINDOW_MS = 5 * 60 * 1000;
const CHECK_INTERVAL = 15000;

const baselineMemory = new Map();
const forecastMemory = new Map();
const behaviorMemory = new Map();

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

    /* ================= ASSET EXPOSURE ================= */

    const assetExposure = {};
    list.forEach(e => {
      const asset = e.targetAsset || "unknown";
      if (!assetExposure[asset]) assetExposure[asset] = 0;
      assetExposure[asset] +=
        e.severity === "critical" ? 25 :
        e.severity === "high" ? 15 :
        e.severity === "medium" ? 8 : 2;
    });

    broadcast({
      type: "asset_exposure_update",
      companyId,
      exposure: assetExposure
    });

    /* ================= ADAPTIVE RISK ================= */

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

    /* ================= FORECAST ================= */

    if (!forecastMemory.has(companyId)) {
      forecastMemory.set(companyId, []);
    }

    const history = forecastMemory.get(companyId);
    history.push({ risk, timestamp: now });
    if (history.length > 10) history.shift();

    let forecastData = null;

    if (history.length >= 3) {
      const first = history[0];
      const last = history[history.length - 1];
      const slope =
        (last.risk - first.risk) /
        ((last.timestamp - first.timestamp) / 1000 || 1);

      forecastData = {
        slope: Number(slope.toFixed(3)),
        probability: Math.min(100, Math.round(slope * 100)),
      };

      broadcast({
        type: "risk_forecast",
        companyId,
        forecast: forecastData
      });
    }

    /* ================= BEHAVIOR DRIFT ================= */

    const signature = JSON.stringify(
      Object.values(assetExposure).sort()
    );

    if (!behaviorMemory.has(companyId)) {
      behaviorMemory.set(companyId, signature);
    } else {
      const previous = behaviorMemory.get(companyId);
      if (previous !== signature) {
        broadcast({
          type: "behavioral_drift",
          companyId,
          message: "Behavioral pattern deviation detected."
        });
        behaviorMemory.set(companyId, signature);
      }
    }

    /* ================= EXECUTIVE HEAT INDEX ================= */

    const exposureScore =
      Object.values(assetExposure).reduce((a, b) => a + b, 0);

    const forecastProbability =
      forecastData?.probability || 0;

    const heatIndex = Math.min(
      100,
      Math.round(
        (risk * 0.4) +
        (exposureScore * 0.2) +
        (forecastProbability * 0.2) +
        (criticalRatio * 100 * 0.2)
      )
    );

    broadcast({
      type: "executive_heat_index",
      companyId,
      heatIndex
    });
  }
}

setInterval(detectIntelligence, CHECK_INTERVAL);

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
