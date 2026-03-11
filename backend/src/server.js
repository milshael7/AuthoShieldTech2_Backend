require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");

/* ================= CORE LIBS ================= */

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

/* ================= ROUTES ================= */

const paperRoutes = require("./routes/paper.routes");
const marketRoutes = require("./routes/market.routes");
const tradingRoutes = require("./routes/trading.routes");

/* ================= SAFE BOOT ================= */

function requireEnv(name){
  if(!process.env[name]){
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
app.set("trust proxy",1);

app.use("/api/stripe/webhook", require("./routes/stripe.webhook.routes"));

app.use(cors({
  origin:process.env.CORS_ORIGIN || false,
  credentials:true
}));

app.use(helmet());
app.use(express.json({limit:"2mb"}));
app.use(morgan("dev"));
app.use(rateLimiter);

/* ================= PUBLIC ROUTES ================= */

app.use("/api/auth", require("./routes/auth.routes"));

/* ================= AUTH ================= */

app.use("/api",(req,res,next)=>{
  if(req.path.startsWith("/auth")) return next();
  return authRequired(req,res,next);
});

app.use("/api",tenantMiddleware);

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

/* ================= TRADING ================= */

app.use("/api/paper", paperRoutes);
app.use("/api/market", marketRoutes);

/* FIXED: allow frontend AI control panel to work */
app.use("/api/ai", tradingRoutes);

/* existing trading routes */
app.use("/api/trading", tradingRoutes);

/* ================= ZERO TRUST ================= */

app.use("/api",(req,res,next)=>{

  if(
    req.path.startsWith("/auth") ||
    req.path.startsWith("/market") ||
    req.path.startsWith("/paper") ||
    req.path.startsWith("/trading") ||
    req.path.startsWith("/ai") ||
    req.path.startsWith("/admin")
  ){
    return next();
  }

  return zeroTrust(req,res,next);

});

/* ================= SERVER ================= */

const server = http.createServer(app);

/* ================= ENGINE METRICS ================= */

const ENGINE_START_TIME = Date.now();

function computeMetrics(snapshot){

  const stats = snapshot?.executionStats || {};

  const decisions = Number(stats.decisions || 0);
  const uptimeMinutes =
    (Date.now() - ENGINE_START_TIME) / 60000;

  const aiPerMin =
    uptimeMinutes > 0
      ? decisions / uptimeMinutes
      : 0;

  const memMb =
    process.memoryUsage().rss / 1024 / 1024;

  return {
    aiPerMin:Number(aiPerMin.toFixed(2)),
    memMb:Number(memMb.toFixed(1))
  };
}

/* ================= START ALL TENANTS ================= */

function bootTenants(){

  try{

    const db = readDb();
    const usersList = db.users || [];
    const tenants = new Set();

    for(const u of usersList){

      const tenantId = u.companyId || u.id;

      if(tenantId)
        tenants.add(tenantId);

    }

    for(const id of tenants){

      marketEngine.registerTenant(id);

      console.log("[AI] tenant initialized:",id);

    }

  }catch(err){

    console.error("Tenant boot error:",err.message);

  }

}

bootTenants();

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({
  server,
  path:"/ws"
});

function closeWs(ws){
  try{ws.close()}catch{}
}

wss.on("connection",(ws,req)=>{

  try{

    const url = new URL(req.url,`http://${req.headers.host}`);

    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "security";

    if(!token) return closeWs(ws);

    const payload = verify(token,"access");

    if(!payload?.id || !payload?.jti)
      return closeWs(ws);

    if(sessionAdapter.isRevoked(payload.jti))
      return closeWs(ws);

    const db = readDb();

    const user = (db.users || []).find(
      u => String(u.id) === String(payload.id)
    );

    if(!user) return closeWs(ws);

    const tenantId = user.companyId || user.id;

    ws.channel = channel;
    ws.tenantId = tenantId;
    ws.isAlive = true;

    marketEngine.registerTenant(tenantId);

    ws.on("pong",()=>{ws.isAlive=true});

  }
  catch{
    closeWs(ws);
  }

});

/* ================= HEARTBEAT ================= */

setInterval(()=>{

  wss.clients.forEach(ws=>{

    if(ws.isAlive===false){
      try{ws.terminate()}catch{}
      return;
    }

    ws.isAlive=false;

    try{ws.ping()}catch{}

  });

},20000);

/* ================= MARKET STREAM ================= */

setInterval(()=>{

  const cache = new Map();

  wss.clients.forEach(ws=>{

    if(ws.channel!=="market") return;

    try{

      let snapshot = cache.get(ws.tenantId);

      if(!snapshot){

        snapshot =
          marketEngine.getMarketSnapshot(ws.tenantId);

        cache.set(ws.tenantId,snapshot);
      }

      ws.send(JSON.stringify({

        channel:"market",
        type:"snapshot",
        data:snapshot,
        ts:Date.now()

      }));

    }
    catch{}

  });

},250);

/* ================= PAPER ENGINE STREAM ================= */

setInterval(()=>{

  wss.clients.forEach(ws=>{

    if(ws.channel!=="paper") return;

    try{

      const snapshot =
        paperTrader.snapshot(ws.tenantId);

      const decisions =
        paperTrader.getDecisions(ws.tenantId);

      const metrics =
        computeMetrics(snapshot);

      ws.send(JSON.stringify({

        channel:"paper",
        type:"engine",
        snapshot,
        decisions,
        metrics,
        engineStart:ENGINE_START_TIME,
        ts:Date.now()

      }));

    }
    catch{}

  });

},800);

/* ================= START ================= */

const port = process.env.PORT || 5000;

server.listen(port,()=>{
  console.log(`[BOOT] Backend running quietly on port ${port}`);
});
