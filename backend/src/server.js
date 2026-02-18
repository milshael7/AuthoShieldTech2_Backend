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

const securityRoutes = require("./routes/security.routes");
const billingRoutes = require("./routes/billing.routes");
const stripeWebhookRoutes = require("./routes/stripe.webhook.routes");

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

ensureDb();
users.ensureAdminFromEnv();

console.log("[BOOT] Backend initialized");

/* =========================================================
   EXPRESS
========================================================= */

const app = express();
app.set("trust proxy", 1);

/* =========================================================
   STRIPE WEBHOOK (MUST BE BEFORE JSON PARSER)
========================================================= */

app.use("/api/stripe/webhook", stripeWebhookRoutes);

/* =========================================================
   CORS
========================================================= */

app.use(
  cors({
    origin: true,
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
    uptime: process.uptime(),
    time: new Date().toISOString(),
  });
});

/* =========================================================
   AUTH ROUTES
========================================================= */

app.use("/api/auth", authLimiter, require("./routes/auth.routes"));

/* =========================================================
   TENANT CONTEXT
========================================================= */

app.use(tenantMiddleware);

/* =========================================================
   API ROUTES
========================================================= */

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
   SERVER + WS
========================================================= */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/market" });

let onlineUsers = 0;

function safeSend(client, payload) {
  if (!client || client.readyState !== 1) return;
  try {
    client.send(payload);
  } catch {}
}

wss.on("connection", (ws) => {
  onlineUsers++;

  ws.on("close", () => {
    onlineUsers = Math.max(onlineUsers - 1, 0);
  });

  ws.on("error", () => {
    onlineUsers = Math.max(onlineUsers - 1, 0);
  });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error("[HTTP ERROR]", err);

  return res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

/* =========================================================
   START
========================================================= */

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`[BOOT] Running on port ${port}`);
});
