// ==========================================================
// FILE: backend/src/server.js
// VERSION: v31.0 (WebSocket Fix + Global Safety + Process Guard)
// ==========================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");

/* =========================================================
CORE LIBRARIES
========================================================= */
const { ensureDb, readDb } = require("./lib/db");
const { verifyAuditIntegrity } = require("./lib/audit");
const { verify } = require("./lib/jwt");
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");
const { authRequired } = require("./middleware/auth");
const marketEngine = require("./services/marketEngine");
const engineCore = require("./engine/engineCore");

/* =========================================================
API ROUTES
========================================================= */
const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");
const tradingRoutes = require("./routes/trading.routes");
const analyticsRoutes = require("./routes/analytics.routes");

/* =========================================================
PRE-BOOT CHECKS
========================================================= */
try {
  ensureDb();
  users.ensureAdminFromEnv();
  verifyAuditIntegrity();
} catch (e) {
  console.error("FATAL BOOT ERROR:", e.message);
}

/* =========================================================
EXPRESS CONFIG
========================================================= */
const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false })); // Flexible for WS
app.use(express.json());
app.use(morgan("dev"));
app.use(rateLimiter);

// Public Routes
app.use("/api/auth", require("./routes/auth.routes"));

// Protected Routes
app.use("/api", authRequired);
app.use("/api", tenantMiddleware);
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/trading", tradingRoutes);
app.use("/api/analytics", analyticsRoutes);

const server = http.createServer(app);

/* =========================================================
TENANT & ENGINE LOGIC
========================================================= */
let TENANT_CACHE = { list: new Set(), updatedAt: 0 };
const TENANT_CACHE_MS = 15000;

function getTenants() {
  const now = Date.now();
  if (now - TENANT_CACHE.updatedAt < TENANT_CACHE_MS) return TENANT_CACHE.list;

  try {
    const db = readDb();
    const tenants = new Set();
    (db?.users || []).forEach(u => tenants.add(String(u.companyId || u.id)));
    TENANT_CACHE = { list: tenants, updatedAt: now };
    return tenants;
  } catch (err) {
    return TENANT_CACHE.list; // Fallback to last known good list
  }
}

// Initial Boot
const initialTenants = getTenants();
initialTenants.forEach(t => {
  try {
    marketEngine.registerTenant(t);
    if (engineCore?.getState) engineCore.getState(t);
  } catch (err) { console.error(`Tenant ${t} boot fail:`, err.message); }
});

// AI ENGINE LOOP (1s)
setInterval(() => {
  const tenants = getTenants();
  const now = Date.now();
  tenants.forEach(tenantId => {
    try {
      const market = marketEngine.getMarketSnapshot(tenantId);
      const price = market?.BTCUSDT?.price || 60000;
      if (engineCore?.processTick) {
        engineCore.processTick({ tenantId, symbol: "BTCUSDT", price: Number(price), ts: now });
      }
    } catch (err) { console.error("TICK ERROR:", err.message); }
  });
}, 1000);

/* =========================================================
WEBSOCKET CORE
========================================================= */
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  try {
    // FIX: More robust URL parsing for Railway/Proxies
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const fullUrl = `${protocol}://${req.headers.host}${req.url}`;
    const url = new URL(fullUrl);

    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "market";

    if (!token) throw new Error("No Token");

    const payload = verify(token, "access");
    if (!payload?.id) throw new Error("Invalid Token");

    ws.channel = channel;
    ws.tenantId = String(payload.companyId || payload.id);
    ws.isAlive = true;

    if (engineCore?.getState) engineCore.getState(ws.tenantId);

    ws.on("pong", () => (ws.isAlive = true));
    ws.on("error", (e) => console.error("WS Socket Error:", e.message));

  } catch (err) {
    console.error("WS Auth Failed:", err.message);
    ws.terminate();
  }
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Market Stream (200ms)
setInterval(() => {
  const cache = new Map();
  wss.clients.forEach((ws) => {
    if (ws.channel !== "market" || ws.readyState !== 1) return;
    let payload = cache.get(ws.tenantId);
    if (!payload) {
      payload = JSON.stringify({ channel: "market", data: marketEngine.getMarketSnapshot(ws.tenantId), ts: Date.now() });
      cache.set(ws.tenantId, payload);
    }
    ws.send(payload);
  });
}, 200);

/* =========================================================
TRADE BROADCAST (Refactored to be Safe)
========================================================= */
global.broadcastTrade = function (trade, tenantId) {
  if (!wss || !wss.clients) return;

  const msg = JSON.stringify({ channel: "paper", type: "trade", trade, ts: Date.now() });

  wss.clients.forEach((ws) => {
    if (ws.channel === "paper" && String(ws.tenantId) === String(tenantId) && ws.readyState === 1) {
      ws.send(msg);
    }
  });
};

/* =========================================================
PROCESS GUARDS (The Railway Safety Net)
========================================================= */
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err.message);
});

/* =========================================================
START
========================================================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 ENGINE v31.0 RUNNING ON PORT ${PORT}`);
});
