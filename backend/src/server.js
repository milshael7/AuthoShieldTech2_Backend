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

/* ROUTES */
const securityRoutes = require("./routes/security.routes");
const billingRoutes = require("./routes/billing.routes");
const webhookRoutes = require("./routes/webhook.routes");

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
requireEnv("STRIPE_WEBHOOK_SECRET");

ensureDb();
users.ensureAdminFromEnv();

/* =========================================================
   SYSTEM STATE INIT
========================================================= */

updateDb((db) => {
  db.systemState = db.systemState || {
    securityStatus: "NORMAL", // NORMAL | WARNING | LOCKDOWN
    lastComplianceCheck: null,
    lastDriftAmount: 0,
  };
  return db;
});

console.log("[BOOT] Backend initialized");

/* =========================================================
   EXPRESS
========================================================= */

const app = express();
app.set("trust proxy", 1);

/* =========================================================
   STRIPE WEBHOOK
========================================================= */

app.use(
  "/api/stripe/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  webhookRoutes
);

/* =========================================================
   CORS
========================================================= */

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
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
   LOCKDOWN ENFORCEMENT MIDDLEWARE
========================================================= */

app.use((req, res, next) => {
  const db = readDb();
  const state = db.systemState || {};

  if (
    state.securityStatus === "LOCKDOWN" &&
    !req.originalUrl.startsWith("/api/admin") &&
    !req.originalUrl.startsWith("/api/billing") &&
    !req.originalUrl.startsWith("/health")
  ) {
    return res.status(503).json({
      ok: false,
      error: "System temporarily locked due to compliance anomaly",
    });
  }

  next();
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  const db = readDb();
  res.json({
    ok: true,
    uptime: process.uptime(),
    systemState: db.systemState,
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
   AUTOMATED COMPLIANCE RUNNER
========================================================= */

async function runComplianceCheck() {
  try {
    const snapshot = generateComplianceReport();

    updateDb((db) => {
      const drift = snapshot.financialIntegrity.revenueDrift;
      const auditOk = snapshot.auditIntegrity?.ok;

      let status = "NORMAL";

      if (!auditOk) status = "LOCKDOWN";
      else if (Math.abs(drift) > 5) status = "WARNING";
      else if (Math.abs(drift) > 25) status = "LOCKDOWN";

      db.systemState = {
        securityStatus: status,
        lastComplianceCheck: new Date().toISOString(),
        lastDriftAmount: drift,
      };

      return db;
    });

    console.log("[COMPLIANCE] Check completed");
  } catch (err) {
    console.error("[COMPLIANCE ERROR]", err);
  }
}

/* Run every 6 hours */
setInterval(runComplianceCheck, 6 * 60 * 60 * 1000);

/* Run once at startup */
runComplianceCheck();

/* =========================================================
   SERVER
========================================================= */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/market" });

let onlineUsers = 0;

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

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "Payload too large",
    });
  }

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
