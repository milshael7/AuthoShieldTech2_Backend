// ==========================================================
// FILE: backend/src/server.js
// VERSION: v28.0 (Stable Engine + No initTenant + Production Safe)
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
const sessionAdapter = require("./lib/sessionAdapter");
const users = require("./users/user.service");

const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");
const zeroTrust = require("./middleware/zeroTrust");
const { authRequired } = require("./middleware/auth");

const marketEngine = require("./services/marketEngine");

/* =========================================================
🔥 REAL ENGINE
========================================================= */

const engineCore = require("./engine/engineCore");

/* =========================================================
API ROUTES
========================================================= */

const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");
const tradingRoutes = require("./routes/trading.routes");
const analyticsRoutes = require("./routes/analytics.routes");

/* =========================================================
BOOT
========================================================= */

ensureDb();
users.ensureAdminFromEnv();
verifyAuditIntegrity();

/* =========================================================
EXPRESS
========================================================= */

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(morgan("dev"));
app.use(rateLimiter);

/* =========================================================
ROUTES
========================================================= */

app.use("/api/auth", require("./routes/auth.routes"));

app.use("/api", authRequired);
app.use("/api", tenantMiddleware);

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/users", require("./routes/users.routes"));

app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/trading", tradingRoutes);
app.use("/api/analytics", analyticsRoutes);

/* =========================================================
HTTP SERVER
========================================================= */

const server = http.createServer(app);

/* =========================================================
TENANT CACHE
========================================================= */

let TENANT_CACHE = { list: new Set(), updatedAt: 0 };
const TENANT_CACHE_MS = 15000;

function getTenants() {
  const now = Date.now();

  if (now - TENANT_CACHE.updatedAt < TENANT_CACHE_MS) {
    return TENANT_CACHE.list;
  }

  const db = readDb();
  const tenants = new Set();

  for (const u of db.users || []) {
    tenants.add(String(u.companyId || u.id));
  }

  TENANT_CACHE = { list: tenants, updatedAt: now };
  return tenants;
}

/* =========================================================
BOOT TENANTS (SAFE)
========================================================= */

(function boot() {
  const tenants = getTenants();

  for (const t of tenants) {
    try {
      marketEngine.registerTenant(t);

      // 🔥 REMOVED initTenant — handled internally now

      // Warm engine state safely
      if (typeof engineCore?.getState === "function") {
        engineCore.getState(t);
      }

    } catch (err) {
      console.error("Tenant boot error:", err.message);
    }
  }
})();

/* =========================================================
🔥 REAL AI ENGINE LOOP
========================================================= */

setInterval(() => {
  try {
    const tenants = getTenants();
    const now = Date.now();

    for (const tenantId of tenants) {
      const market = marketEngine.getMarketSnapshot(tenantId);
      const price = market?.BTCUSDT?.price || 60000;

      if (typeof engineCore?.processTick === "function") {
        engineCore.processTick({
          tenantId,
          symbol: "BTCUSDT",
          price: Number(price),
          ts: now,
        });
      }
    }
  } catch (err) {
    console.error("ENGINE ERROR:", err.message);
  }
}, 1000);

/* =========================================================
WEBSOCKET
========================================================= */

const wss = new WebSocketServer({ server, path: "/ws" });

function closeWs(ws) {
  try { ws.close(); } catch {}
}

/* =========================================================
AUTH
========================================================= */

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "market";

    if (!token) return closeWs(ws);

    const payload = verify(token, "access");
    if (!payload?.id) return closeWs(ws);

    ws.channel = channel;
    ws.tenantId = String(payload.companyId || payload.id);
    ws.isAlive = true;

    // 🔥 NO initTenant — engine auto handles state

    // Warm state safely
    if (typeof engineCore?.getState === "function") {
      engineCore.getState(ws.tenantId);
    }

    ws.on("pong", () => (ws.isAlive = true));

  } catch {
    closeWs(ws);
  }
});

/* =========================================================
HEARTBEAT
========================================================= */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return closeWs(ws);
    ws.isAlive = false;
    try { ws.ping(); } catch { closeWs(ws); }
  });
}, 30000);

/* =========================================================
MARKET STREAM
========================================================= */

setInterval(() => {
  const cache = new Map();

  wss.clients.forEach((ws) => {
    if (ws.channel !== "market") return;
    if (ws.readyState !== ws.OPEN) return;

    let payload = cache.get(ws.tenantId);

    if (!payload) {
      const snapshot = marketEngine.getMarketSnapshot(ws.tenantId);

      payload = JSON.stringify({
        channel: "market",
        data: snapshot,
        ts: Date.now(),
      });

      cache.set(ws.tenantId, payload);
    }

    ws.send(payload);
  });
}, 200);

/* =========================================================
🔥 ENGINE STATE STREAM
========================================================= */

setInterval(() => {
  const cache = new Map();

  wss.clients.forEach((ws) => {
    if (ws.channel !== "paper") return;
    if (ws.readyState !== ws.OPEN) return;

    let payload = cache.get(ws.tenantId);

    if (!payload) {
      const state =
        typeof engineCore?.getState === "function"
          ? engineCore.getState(ws.tenantId)
          : {};

      payload = JSON.stringify({
        channel: "paper",
        type: "engine",
        snapshot: state,
        ts: Date.now(),
      });

      cache.set(ws.tenantId, payload);
    }

    ws.send(payload);
  });
}, 500);

/* =========================================================
TRADE BROADCAST
========================================================= */

global.broadcastTrade = function (trade, tenantId) {
  const msg = JSON.stringify({
    channel: "paper",
    type: "trade",
    trade,
    ts: Date.now(),
  });

  wss.clients.forEach((ws) => {
    if (ws.channel !== "paper") return;
    if (String(ws.tenantId) !== String(tenantId)) return;
    if (ws.readyState !== ws.OPEN) return;

    ws.send(msg);
  });
};

/* =========================================================
START
========================================================= */

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 ENGINE RUNNING ON PORT ${PORT}`);
});
