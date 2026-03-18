// ==========================================================
// FILE: backend/src/server.js
// MODULE: Core Backend Server
// VERSION: Production Stable + Real-Time Trade Broadcast
// PURPOSE
// Main backend runtime entry point.
//
// FIXED
// - Real tenant-safe websocket resolution
// - Stable paper snapshot delivery
// - Correct BTCUSDT fallback price source
// - Heartbeat cleanup for dead sockets
// - Snapshot normalization for frontend persistence
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
const paperTrader = require("./services/paperTrader");

/* =========================================================
API ROUTES
========================================================= */

const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");
const tradingRoutes = require("./routes/trading.routes");

/* =========================================================
SAFE BOOT CHECK
========================================================= */

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[BOOT] Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv("JWT_SECRET");
requireEnv("STRIPE_SECRET_KEY");
requireEnv("STRIPE_WEBHOOK_SECRET");

/* =========================================================
SYSTEM INITIALIZATION
========================================================= */

ensureDb();
users.ensureAdminFromEnv();
verifyAuditIntegrity();

/* =========================================================
EXPRESS SERVER
========================================================= */

const app = express();
app.set("trust proxy", 1);

/* =========================================================
STRIPE WEBHOOK
========================================================= */

app.use("/api/stripe/webhook", require("./routes/stripe.webhook.routes"));

/* =========================================================
SECURITY MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || false,
    credentials: true,
  })
);

app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use(rateLimiter);

/* =========================================================
PUBLIC ROUTES
========================================================= */

app.use("/api/auth", require("./routes/auth.routes"));

/* =========================================================
AUTHENTICATION
========================================================= */

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return authRequired(req, res, next);
});

/* =========================================================
TENANT RESOLUTION
========================================================= */

app.use("/api", tenantMiddleware);

/* =========================================================
CORE API ROUTES
========================================================= */

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/security/tools", require("./routes/tools.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/soc", require("./routes/soc.routes"));

/* =========================================================
TRADING API
========================================================= */

app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/ai", tradingRoutes);
app.use("/api/trading", tradingRoutes);

/* =========================================================
ZERO TRUST LAYER
========================================================= */

app.use("/api", (req, res, next) => {
  if (
    req.path.startsWith("/auth") ||
    req.path.startsWith("/market") ||
    req.path.startsWith("/paper") ||
    req.path.startsWith("/trading") ||
    req.path.startsWith("/ai") ||
    req.path.startsWith("/admin")
  ) {
    return next();
  }

  return zeroTrust(req, res, next);
});

/* =========================================================
HTTP SERVER
========================================================= */

const server = http.createServer(app);

/* =========================================================
AI ENGINE START TIME
========================================================= */

const ENGINE_START_TIME = Date.now();

/* =========================================================
TENANT DISCOVERY
========================================================= */

function getTenants() {
  const db = readDb();
  const usersList = db.users || [];

  const tenants = new Set();

  for (const u of usersList) {
    const tenantId = u.companyId || u.id;
    if (tenantId !== undefined && tenantId !== null && tenantId !== "") {
      tenants.add(String(tenantId));
    }
  }

  return tenants;
}

/* =========================================================
TENANT ENGINE BOOT
========================================================= */

function bootTenants() {
  try {
    const tenants = getTenants();

    for (const id of tenants) {
      marketEngine.registerTenant(id);
      console.log("[AI] tenant initialized:", id);
    }
  } catch (err) {
    console.error("Tenant boot error:", err.message);
  }
}

bootTenants();

/* =========================================================
SNAPSHOT NORMALIZER
========================================================= */

function buildPaperSnapshot(tenantId) {
  const base = paperTrader.snapshot(tenantId) || {};
  const decisions = paperTrader.getDecisions(tenantId) || [];

  const cashBalance = Number(base.cashBalance || 0);
  const lockedCapital = Number(base.lockedCapital || 0);
  const availableCapital = Number(
    base.availableCapital != null ? base.availableCapital : cashBalance
  );

  return {
    ...base,
    decisions,
    totalCapital: cashBalance + lockedCapital,
    equity: cashBalance,
    availableCapital,
    lockedCapital,
    lastPrice:
      Number(base?.lastPriceBySymbol?.BTCUSDT) ||
      Number(base?.lastPriceBySymbol?.BTCUSD) ||
      null,
  };
}

/* =========================================================
AUTONOMOUS AI TRADING ENGINE
========================================================= */

setInterval(() => {
  try {
    const tenants = getTenants();

    for (const tenantId of tenants) {
      const market = marketEngine.getMarketSnapshot(tenantId);

      let price = market?.BTCUSDT?.price;

      if (!price) {
        const snap = paperTrader.snapshot(tenantId) || {};
        const last =
          Number(snap?.lastPriceBySymbol?.BTCUSDT) ||
          Number(snap?.lastPriceBySymbol?.BTCUSD) ||
          0;

        if (Number.isFinite(last) && last > 0) {
          price = last;
        }
      }

      if (!price) {
        price = 60000;
      }

      paperTrader.tick(tenantId, "BTCUSDT", Number(price), Date.now());
    }
  } catch (err) {
    console.error("AI engine error:", err.message);
  }
}, 1000);

/* =========================================================
WEBSOCKET SERVER
========================================================= */

const wss = new WebSocketServer({
  server,
  path: "/ws",
});

/* =========================================================
REAL TIME TRADE BROADCAST
========================================================= */

function broadcastTrade(trade, tenantId) {
  const normalizedTenantId = String(tenantId);

  wss.clients.forEach((ws) => {
    if (ws.channel !== "paper") return;
    if (String(ws.tenantId) !== normalizedTenantId) return;
    if (ws.readyState !== ws.OPEN) return;

    try {
      ws.send(
        JSON.stringify({
          channel: "paper",
          type: "trade",
          trade,
          ts: Date.now(),
        })
      );
    } catch {}
  });
}

/* expose globally so executionEngine can use it */
global.broadcastTrade = broadcastTrade;

function closeWs(ws) {
  try {
    ws.close();
  } catch {}
}

/* =========================================================
WEBSOCKET TENANT RESOLUTION
========================================================= */

function resolveSocketTenant(user, requestedTenantId) {
  const userId = String(user?.id || "");
  const companyId =
    user?.companyId !== undefined && user?.companyId !== null
      ? String(user.companyId)
      : null;

  if (!requestedTenantId) {
    return companyId || userId;
  }

  const requested = String(requestedTenantId);

  if (companyId && requested === companyId) {
    return companyId;
  }

  if (requested === userId) {
    return userId;
  }

  return companyId || userId;
}

/* =========================================================
WEBSOCKET AUTHENTICATION
========================================================= */

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "security";
    const requestedTenantId = url.searchParams.get("companyId");

    if (!token) return closeWs(ws);

    const payload = verify(token, "access");

    if (!payload?.id || !payload?.jti) {
      return closeWs(ws);
    }

    if (sessionAdapter.isRevoked(payload.jti)) {
      return closeWs(ws);
    }

    const db = readDb();

    const user = (db.users || []).find(
      (u) => String(u.id) === String(payload.id)
    );

    if (!user) return closeWs(ws);

    const tenantId = resolveSocketTenant(user, requestedTenantId);

    ws.channel = channel;
    ws.tenantId = String(tenantId);
    ws.userId = String(user.id);
    ws.isAlive = true;

    marketEngine.registerTenant(ws.tenantId);

    ws.on("pong", () => {
      ws.isAlive = true;
    });
  } catch {
    closeWs(ws);
  }
});

/* =========================================================
WEBSOCKET HEARTBEAT
========================================================= */

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return closeWs(ws);
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch {
      closeWs(ws);
    }
  });
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

/* =========================================================
MARKET STREAM
========================================================= */

setInterval(() => {
  const cache = new Map();

  wss.clients.forEach((ws) => {
    if (ws.channel !== "market") return;
    if (ws.readyState !== ws.OPEN) return;

    try {
      let snapshot = cache.get(ws.tenantId);

      if (!snapshot) {
        snapshot = marketEngine.getMarketSnapshot(ws.tenantId);
        cache.set(ws.tenantId, snapshot);
      }

      ws.send(
        JSON.stringify({
          channel: "market",
          type: "snapshot",
          data: snapshot,
          ts: Date.now(),
        })
      );
    } catch {}
  });
}, 250);

/* =========================================================
PAPER TRADING STREAM
========================================================= */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.channel !== "paper") return;
    if (ws.readyState !== ws.OPEN) return;

    try {
      const snapshot = buildPaperSnapshot(ws.tenantId);
      const stats = snapshot?.executionStats || {};

      const metrics = {
        aiPerMin: Number(stats.decisions || 0),
        memMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      };

      ws.send(
        JSON.stringify({
          channel: "paper",
          type: "engine",
          snapshot,
          decisions: snapshot.decisions || [],
          metrics,
          engineStart: ENGINE_START_TIME,
          ts: Date.now(),
        })
      );
    } catch {}
  });
}, 800);

/* =========================================================
SERVER START
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Backend running quietly on port ${port}`);
});
