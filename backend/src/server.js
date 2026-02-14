require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { WebSocketServer } = require("ws");

const { ensureDb } = require("./lib/db");
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");

const paperTrader = require("./services/paperTrader");
const liveTrader = require("./services/liveTrader");
const { startKrakenFeed } = require("./services/krakenFeed");

const securityRoutes = require("./routes/security.routes");

/* =========================================================
   SAFE BOOT + ENV CHECKS
========================================================= */

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[BOOT] Missing required env var: ${name}`);
    process.exit(1);
  }
}

function bootLog(msg) {
  console.log(`[BOOT] ${msg}`);
}

bootLog("Initializing AutoShield Backend...");

ensureDb();
requireEnv("JWT_SECRET");
users.ensureAdminFromEnv();

bootLog("Environment OK");

/* =========================================================
   EXPRESS APP
========================================================= */

const app = express();
app.set("trust proxy", 1);

/* =========================================================
   GLOBAL METRICS STATE
========================================================= */

const ACTIVE_TENANTS = new Set();
let last = {};
let lastTickTs = 0;
let krakenStatus = "booting";
let krakenConnectedAt = 0;

/* =========================================================
   CORS
========================================================= */

const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!allowlist.length) return cb(null, true);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);

/* =========================================================
   SECURITY
========================================================= */

app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATELIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

/* =========================================================
   HEALTH + SYSTEM STATUS
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "autoshield-tech-backend",
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    activeTenants: ACTIVE_TENANTS.size,
    krakenStatus,
    tickFreshnessMs: Date.now() - lastTickTs,
    time: new Date().toISOString(),
  });
});

/* =========================================================
   SYSTEM METRICS (NEW — SECURE INTERNAL VIEW)
========================================================= */

app.get("/api/system/metrics", (req, res) => {
  res.json({
    ok: true,
    process: {
      uptime: process.uptime(),
      memoryRss: process.memoryUsage().rss,
      cpuUser: process.cpuUsage().user,
    },
    websocket: {
      clients: wss.clients.size,
    },
    feed: {
      status: krakenStatus,
      connectedAt: krakenConnectedAt,
      lastTickTs,
      freshnessMs: lastTickTs
        ? Date.now() - lastTickTs
        : null,
      trackedSymbols: Object.keys(last).length,
    },
    engine: {
      activeTenants: ACTIVE_TENANTS.size,
    },
    time: new Date().toISOString(),
  });
});

/* =========================================================
   AUTH ROUTES (NO TENANT)
========================================================= */

app.use("/api/auth", authLimiter, require("./routes/auth.routes"));

/* =========================================================
   TENANT CONTEXT
========================================================= */

app.use(tenantMiddleware);

/* =========================================================
   TENANT ENGINE REGISTRY
========================================================= */

function registerTenant(tenantId) {
  if (!tenantId) return;
  if (ACTIVE_TENANTS.has(tenantId)) return;

  ACTIVE_TENANTS.add(tenantId);

  paperTrader.start?.(tenantId);
  liveTrader.start?.(tenantId);

  console.log("[engine] registered tenant:", tenantId);
}

app.use((req, res, next) => {
  const tenantId = req.tenant?.id || req.tenantId;
  if (tenantId) registerTenant(tenantId);
  next();
});

/* =========================================================
   TENANT ROUTES
========================================================= */

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/manager", require("./routes/manager.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/me", require("./routes/me.routes"));
app.use("/api/trading", require("./routes/trading.routes"));
app.use("/api/ai", require("./routes/ai.routes"));
app.use("/api/voice", require("./routes/voice.routes"));
app.use("/api/live", require("./routes/live.routes"));
app.use("/api/paper", require("./routes/paper.routes"));
app.use("/api/security", securityRoutes);

/* =========================================================
   SERVER + WEBSOCKET
========================================================= */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/market" });

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(payload); } catch {}
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "hello",
      symbols: Object.keys(last),
      last,
      ts: Date.now(),
    })
  );
});

/* =========================================================
   KRAKEN FEED
========================================================= */

let krakenStop = null;

try {
  krakenStop = startKrakenFeed({
    onStatus: (s) => {
      krakenStatus = s;
      if (s === "connected") {
        krakenConnectedAt = Date.now();
      }
      console.log("[kraken]", s);
    },

    onTick: (tick) => {
      last[tick.symbol] = tick.price;
      lastTickTs = Date.now();

      if (ACTIVE_TENANTS.size === 0) return;

      for (const tenantId of ACTIVE_TENANTS) {
        try {
          paperTrader.tick(
            tenantId,
            tick.symbol,
            tick.price,
            tick.ts
          );

          liveTrader.tick(
            tenantId,
            tick.symbol,
            tick.price,
            tick.ts
          );
        } catch (err) {
          console.error("[engine tick error]", err);
        }
      }

      broadcast({ type: "tick", ...tick });
    },
  });

  bootLog("Kraken feed started");
} catch (e) {
  krakenStatus = "failed";
  console.error("Failed to start Kraken feed:", e);
}

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error("[HTTP ERROR]", err);

  if (err?.message?.toLowerCase()?.includes("cors")) {
    return res.status(403).json({
      ok: false,
      error: "CORS blocked",
      detail: err.message,
    });
  }

  return res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

/* =========================================================
   START SERVER
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  bootLog(`Backend running on port ${port}`);
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("[shutdown] Closing services...");

  try { krakenStop && krakenStop.stop(); } catch {}
  try { wss.close(); } catch {}
  try {
    server.close(() => {
      console.log("[shutdown] Complete");
      process.exit(0);
    });
  } catch {
    process.exit(1);
  }
}
