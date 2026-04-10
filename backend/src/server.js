// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.7 (UNIFIED SYNC & BOOT-READY)
// FILE: backend/src/server.js
// ==========================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const { verify } = require("./lib/jwt");

// Service & Engine Imports
const marketEngine = require("./services/marketEngine");
const engineCore = require("./engine/engineCore"); 

const app = express();

/* ================= 🔧 MISSION-CRITICAL CORS ================= */
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  /\.vercel\.app$/ // Allows any Vercel deployment branch
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json());

/* ================= 🧠 UNIFIED EXECUTION LAYER ================= */
global.lastConfidence = 0;

/**
 * Global Stealth Gate
 * The AI signal is environment-blind. This switch decides the "Pipe".
 */
global.executeStealthTrade = async function(side, price, confidence, tenantId = 'default') {
  const isLive = process.env.LIVE_TRADING === 'true';
  global.lastConfidence = confidence;
  
  console.log(`[SYS]: ${isLive ? 'LIVE' : 'PAPER'} GATE | Side: ${side} | Conf: ${confidence}%`);

  if (confidence > 25) {
    // If Live, we'd trigger Kraken here. Otherwise, process via EngineCore.
    return isLive ? "LIVE_ORDER_SENT" : engineCore.processTick({ tenantId, symbol: "BTCUSDT", price });
  }
  return "WAITING_FOR_SIGNAL";
};

/* ================= 🚀 API ROUTES (PRIORITY) ================= */
// We place these ABOVE the "/" route so they are never intercepted
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes"));
app.use("/api/system", require("./routes/system.routes")); 

/* ================= 🖥️ MONITORING DASHBOARD ================= */
app.get("/", (req, res) => {
  res.json({
    status: "STABLE",
    version: "v32.7",
    gate: process.env.LIVE_TRADING === 'true' ? "LIVE" : "PAPER",
    uptime: process.uptime()
  });
});

const server = http.createServer(app);

/* ================= 🛰️ WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    
    if (token) {
      const payload = verify(token, "access");
      ws.tenantId = String(payload.companyId || payload.id);
    } else {
      ws.tenantId = "guest";
    }
    
    ws.channel = url.searchParams.get("channel") || "market";
    marketEngine.registerTenant(ws.tenantId);
    
    console.log(`[WS]: Connected | Tenant: ${ws.tenantId} | Chan: ${ws.channel}`);
  } catch (err) { 
    ws.terminate(); 
  }
});

/* ================= 🏁 RENDER STARTUP ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`
  =========================================
  🚀 AUTOSHIELD v32.7 IS LIVE
  📡 PORT: ${PORT}
  🛡️ MODE: ${process.env.LIVE_TRADING === 'true' ? 'LIVE' : 'PAPER'}
  =========================================
  `);
});

process.on('uncaughtException', (err) => console.error('SHIELDED ERROR:', err.stack));
