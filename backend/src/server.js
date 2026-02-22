require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { WebSocketServer } = require("ws");

const { ensureDb, readDb, updateDb } = require("./lib/db");
const users = require("./users/user.service");
const tenantMiddleware = require("./middleware/tenant");

const { generateComplianceReport } = require("./services/compliance.service");

/* ================= TRADING ENGINES ================= */

const liveTrader = require("./services/liveTrader");
const aiBrain = require("./services/aiBrain");

/* ROUTES */
const securityRoutes = require("./routes/security.routes");
const billingRoutes = require("./routes/billing.routes");

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

/* =========================================================
   STRIPE WEBHOOK (OPTIONAL ENABLE)
========================================================= */

if (process.env.STRIPE_WEBHOOK_SECRET) {
  const webhookRoutes = require("./routes/stripe.webhook.routes");

  app.use(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    webhookRoutes
  );

  console.log("[BOOT] Stripe webhook enabled");
} else {
  console.log("[BOOT] Stripe webhook disabled (no STRIPE_WEBHOOK_SECRET)");
}

/* =========================================================
   CORS
========================================================= */

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
   API ROUTES
========================================================= */

app.use("/api/auth", require("./routes/auth.routes"));
app.use(tenantMiddleware);

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/manager", require("./routes/manager.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/me", require("./routes/me.routes"));
app.use("/api/security", securityRoutes);
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
const wss = new WebSocketServer({ server, path: "/ws/market" });

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(message); } catch {}
    }
  });
}

const SYMBOL = "BTCUSDT";
let lastPrice = 40000;

setInterval(() => {
  const delta = (Math.random() - 0.5) * 60;
  lastPrice = Math.max(1000, lastPrice + delta);
  const ts = Date.now();

  broadcast({
    type: "tick",
    symbol: SYMBOL,
    price: lastPrice,
    ts,
  });
}, 2000);

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
