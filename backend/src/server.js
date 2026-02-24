require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");

const { ensureDb, readDb } = require("./lib/db");
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");

/* ================= TRADING ENGINES ================= */

const liveTrader = require("./services/liveTrader");
const aiBrain = require("./services/aiBrain");

/* ROUTES */
const securityRoutes = require("./routes/security.routes");
const billingRoutes = require("./routes/billing.routes");
const incidentsRoutes = require("./routes/incidents.routes");

/* =========================================================
   SAFE BOOT
========================================================= */

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

/* =========================================================
   EXPRESS
========================================================= */

const app = express();
app.set("trust proxy", 1);

/* ================= STRIPE WEBHOOK ================= */

if (process.env.STRIPE_WEBHOOK_SECRET) {
  const webhookRoutes = require("./routes/stripe.webhook.routes");

  app.use(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    webhookRoutes
  );

  console.log("[BOOT] Stripe webhook enabled");
} else {
  console.log("[BOOT] Stripe webhook disabled");
}

/* ================= MIDDLEWARE ================= */

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  })
);

app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (req, res) => {
  try {
    const db = readDb();

    res.json({
      ok: true,
      database: !!db,
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/* ================= ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));

app.use(tenantMiddleware);

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/manager", require("./routes/manager.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/me", require("./routes/me.routes"));
app.use("/api/security", securityRoutes);
app.use("/api/incidents", incidentsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/trading", require("./routes/trading.routes"));
app.use("/api/ai", require("./routes/ai.routes"));
app.use("/api/voice", require("./routes/voice.routes"));
app.use("/api/live", require("./routes/live.routes"));
app.use("/api/paper", require("./routes/paper.routes"));

/* =========================================================
   SERVER
========================================================= */

const server = http.createServer(app);

/* ================= SECURED WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path: "/ws/market",
});

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(1008, "Missing token");
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    ws.user = {
      id: decoded.id,
      role: decoded.role,
      companyId: decoded.companyId || null,
    };

    console.log(`[WS] Connected → ${ws.user.id} (${ws.user.role})`);

  } catch (err) {
    ws.close(1008, "Invalid token");
  }
});

/* =========================================================
   SAFE BROADCAST CORE
========================================================= */

function broadcast(payload, filterFn = null) {
  const message = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (filterFn && !filterFn(client)) return;

    try {
      client.send(message);
    } catch {}
  });
}

/* =========================================================
   REAL-TIME SECURITY EVENT BROADCAST
========================================================= */

function broadcastSecurityEvent(event) {
  broadcast(
    {
      type: "security_event",
      event,
    },
    (client) => {
      // Admin sees all
      if (client.user?.role === "Admin") return true;

      // Company isolation
      if (event.companyId && client.user?.companyId !== event.companyId)
        return false;

      return true;
    }
  );
}

/* Make available to routes */
app.set("broadcastSecurityEvent", broadcastSecurityEvent);

/* =========================================================
   MARKET SIMULATION
========================================================= */

const SYMBOL = "BTCUSDT";
let lastPrice = 40000;

setInterval(() => {
  const delta = (Math.random() - 0.5) * 60;
  lastPrice = Math.max(1000, lastPrice + delta);

  broadcast({
    type: "tick",
    symbol: SYMBOL,
    price: lastPrice,
    ts: Date.now(),
  });
}, 2000);

/* =========================================================
   START
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
