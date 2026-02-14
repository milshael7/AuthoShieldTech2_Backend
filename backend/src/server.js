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
   ENV CHECKS
========================================================= */

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

ensureDb();
requireEnv("JWT_SECRET");
users.ensureAdminFromEnv();

/* =========================================================
   EXPRESS APP
========================================================= */

const app = express();
app.set("trust proxy", 1);

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
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "autoshield-tech-backend",
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
   GLOBAL TENANT ENGINE REGISTRATION
   (CRITICAL: Must run BEFORE routes)
========================================================= */

const ACTIVE_TENANTS = new Set();

function registerTenant(tenantId) {
  if (!tenantId) return;
  if (ACTIVE_TENANTS.has(tenantId)) return;

  ACTIVE_TENANTS.add(tenantId);

  paperTrader.start?.(tenantId);
  liveTrader.start?.(tenantId);
}

// 🔥 REGISTER TENANT IMMEDIATELY AFTER TENANT MIDDLEWARE
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

let last = {};

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
    onStatus: (s) => console.log("[kraken]", s),

    onTick: (tick) => {
      last[tick.symbol] = tick.price;

      for (const tenantId of ACTIVE_TENANTS) {
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
      }

      broadcast({ type: "tick", ...tick });
    },
  });
} catch (e) {
  console.error("Failed to start Kraken feed:", e);
}

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  if (err && String(err.message || "").toLowerCase().includes("cors")) {
    return res.status(403).json({
      ok: false,
      error: "CORS blocked",
      detail: err.message,
    });
  }
  return next(err);
});

/* =========================================================
   START SERVER
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () =>
  console.log("AutoShield Tech backend running on", port)
);

/* =========================================================
   SHUTDOWN
========================================================= */

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("Shutting down...");
  try { krakenStop && krakenStop.stop(); } catch {}
  try { wss.close(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(1); }
}
