require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");

/* ================= CORE LIBS ================= */

const { ensureDb } = require("./lib/db");
const { verifyAuditIntegrity } = require("./lib/audit");
const users = require("./users/user.service");

const tenantMiddleware = require("./middleware/tenant");
const rateLimiter = require("./middleware/rateLimiter");
const zeroTrust = require("./middleware/zeroTrust");
const { authRequired } = require("./middleware/auth");

/* ================= ROUTES ================= */

const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");

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
verifyAuditIntegrity();

/* ================= EXPRESS ================= */

const app = express();
app.set("trust proxy", 1);

/* Stripe webhook BEFORE json parser */
app.use("/api/stripe/webhook", require("./routes/stripe.webhook.routes"));

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

/* ================= PUBLIC ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));

/* ================= AUTH + TENANT ================= */

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return authRequired(req, res, next);
});

app.use("/api", tenantMiddleware);

/* ================= CORE API ================= */

app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/security", require("./routes/security.routes"));
app.use("/api/security/tools", require("./routes/tools.routes"));
app.use("/api/incidents", require("./routes/incidents.routes"));
app.use("/api/entitlements", require("./routes/entitlements.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/company", require("./routes/company.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/soc", require("./routes/soc.routes"));

/* ================= MARKET + PAPER (SAFE, REST ONLY) ================= */

app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);

/* ================= ZERO TRUST (CONTROLLED SCOPE) ================= */

app.use("/api", (req, res, next) => {
  if (
    req.path.startsWith("/auth") ||
    req.path.startsWith("/market") ||
    req.path.startsWith("/paper")
  ) {
    return next();
  }
  return zeroTrust(req, res, next);
});

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= START ================= */

const port = process.env.PORT || 5000;
server.listen(port, () => {
  console.log(`[BOOT] Backend running quietly on port ${port}`);
});
