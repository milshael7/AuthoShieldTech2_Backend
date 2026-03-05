require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");

/* ================= CORE LIBS ================= */

const { ensureDb, readDb } = require("./lib/db");
const { verifyAuditIntegrity, writeAudit } = require("./lib/audit");
const { verify } = require("./lib/jwt");
const sessionAdapter = require("./lib/sessionAdapter");
const { classifyDeviceRisk } = require("./lib/deviceFingerprint");
const { verifyRevenueLedger } = require("./lib/revenueIntegrity");

const users = require("./users/user.service");

const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");
const zeroTrust = require("./middleware/zeroTrust");
const { authRequired } = require("./middleware/auth");

/* ================= ROUTES ================= */

const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");

/* ===== OPTIONAL ROUTES ===== */

let trainingRoutes;
let replayRoutes;
let dataRoutes;

try { trainingRoutes = require("./routes/training.routes"); } catch {}
try { replayRoutes = require("./routes/replay.routes"); } catch {}
try { dataRoutes = require("./routes/data.routes"); } catch {}

/* ================= ENGINES ================= */

const paperTrader = require("./services/paperTrader");
const marketEngine = require("./services/marketEngine");

/* ===== OPTIONAL AI ENGINES ===== */

let strategyDiscovery;
let replayEngine;
let regimeDetector;

try { strategyDiscovery = require("./services/strategyDiscovery"); } catch {}
try { replayEngine = require("./services/marketReplayEngine"); } catch {}
try { regimeDetector = require("./services/marketRegimeDetector"); } catch {}

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

verifyAuditIntegrity();
verifyRevenueLedger();

/* ================= EXPRESS ================= */

const app = express();
app.set("trust proxy", 1);

/* Stripe webhook BEFORE json parser */
app.use("/api/stripe/webhook", require("./routes/stripe.webhook.routes"));

app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  credentials: true
}));

app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));
app.use(rateLimiter);

/* ================= PUBLIC ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));

/* ================= PROTECTED ROUTES ================= */

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return authRequired(req, res, next);
});

app.use("/api", tenantMiddleware);

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return zeroTrust(req, res, next);
});

/* ================= CORE API ================= */

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/tools", require("./routes/tools.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/autoprotect", require("./routes/autoprotect.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/soc", require("./routes/soc.routes"));

/* ================= MARKET + PAPER ================= */

app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);

/* ================= OPTIONAL ROUTES ================= */

if (trainingRoutes) app.use("/api/training", trainingRoutes);
if (replayRoutes) app.use("/api/replay", replayRoutes);
if (dataRoutes) app.use("/api/data", dataRoutes);

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

function wsClose(ws) {
  try { ws.close(); } catch {}
}

/* ===== HEARTBEAT ===== */

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws, req) => {

  ws.isAlive = true;
  ws.on("pong", heartbeat);

  try {

    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) return wsClose(ws);

    const payload = verify(token, "access");

    if (!payload?.id || !payload?.jti) return wsClose(ws);

    if (sessionAdapter.isRevoked(payload.jti)) return wsClose(ws);

    const db = readDb();

    const user = (db.users || []).find(
      u => String(u.id) === String(payload.id)
    );

    if (!user) return wsClose(ws);
    if (user.locked === true) return wsClose(ws);

    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      sessionAdapter.revokeToken(payload.jti);
      return wsClose(ws);
    }

    const deviceCheck =
      classifyDeviceRisk(user.activeDeviceFingerprint, req);

    if (!deviceCheck.match) {
      sessionAdapter.revokeAllUserSessions(user.id);
      return wsClose(ws);
    }

    sessionAdapter.registerSession(user.id, payload.jti, 15 * 60 * 1000);

    writeAudit({
      actor: user.id,
      role: user.role,
      action: "WEBSOCKET_CONNECTED",
      detail: { path: req.url }
    });

    const tenantId = user.companyId || user.id;
    const symbol = "BTCUSDT";

    marketEngine.registerTenant(tenantId);

    const tickInterval = setInterval(() => {

      if (ws.readyState !== 1) return;

      const price =
        marketEngine.getPrice(tenantId, symbol);

      if (!price) return;

      ws.send(JSON.stringify({
        type: "tick",
        symbol,
        price,
        ts: Date.now()
      }));

    }, 500);

    ws.on("close", () => {
      clearInterval(tickInterval);
    });

  } catch (err) {

    console.error("WS connection error:", err);
    wsClose(ws);

  }

});

/* ===== CLEAN DEAD CONNECTIONS ===== */

setInterval(() => {

  wss.clients.forEach((ws) => {

    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();

  });

}, 30000);

/* ================= LIVE AI LOOP ================= */

setInterval(() => {

  const db = readDb();

  for (const user of db.users || []) {

    const tenantId = user.companyId || user.id;

    try {

      const price =
        marketEngine.getPrice(tenantId, "BTCUSDT");

      if (!price) continue;

      paperTrader.tick(tenantId, "BTCUSDT", price);

    } catch (err) {

      console.error("AI engine error:", err);

    }

  }

}, 1000);

/* ================= REGIME DETECTOR ================= */

if (regimeDetector) {

  setInterval(() => {

    try {

      const db = readDb();

      for (const user of db.users || []) {

        const tenantId = user.companyId || user.id;

        const price =
          marketEngine.getPrice(tenantId, "BTCUSDT");

        if (!price) continue;

        regimeDetector.update({
          tenantId,
          symbol: "BTCUSDT",
          price
        });

      }

    } catch (err) {

      console.error("Regime detector error:", err);

    }

  }, 5000);

}

/* ================= AI TRAINING LOOP ================= */

if (strategyDiscovery && replayEngine) {

  setInterval(async () => {

    try {

      const db = readDb();

      for (const user of db.users || []) {

        const tenantId = user.companyId || user.id;

        await strategyDiscovery.discoverStrategy({
          tenantId,
          symbol: "BTCUSDT"
        });

      }

    } catch (err) {

      console.error("AI training error:", err);

    }

  }, 300000);

}

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {

  console.log(`[BOOT] Running on port ${port}`);
  console.log("[AI] Live engine running");

  if (strategyDiscovery && replayEngine) {
    console.log("[AI] Training engine running");
  } else {
    console.log("[AI] Training engine disabled");
  }

  if (regimeDetector) {
    console.log("[AI] Market regime detector active");
  }

});
