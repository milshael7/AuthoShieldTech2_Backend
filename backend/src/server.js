// ==========================================================
// 🔒 AUTOSHIELD CORE — v33.0 (BROADCAST-ENABLED)
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
const paperTrader = require("./services/paperTrader"); // Corrected to paperTrader for paper channel sync
const engineCore = require("./engine/engineCore"); 

const app = express();

/* ================= 🔧 MISSION-CRITICAL CORS ================= */
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  /\.vercel\.app$/ 
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json());

/* ================= 🧠 UNIFIED EXECUTION LAYER ================= */
global.lastConfidence = 0;

global.executeStealthTrade = async function(side, price, confidence, tenantId = 'default') {
  const isLive = process.env.LIVE_TRADING === 'true';
  global.lastConfidence = confidence;
  
  console.log(`[SYS]: ${isLive ? 'LIVE' : 'PAPER'} GATE | Side: ${side} | Conf: ${confidence}%`);

  if (confidence > 25) {
    return isLive ? "LIVE_ORDER_SENT" : paperTrader.tick(tenantId, "BTCUSDT", price);
  }
  return "WAITING_FOR_SIGNAL";
};

/* ================= 🚀 API ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes"));
app.use("/api/system", require("./routes/system.routes")); 

app.get("/", (req, res) => {
  res.json({
    status: "STABLE",
    version: "v33.0",
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

/**
 * 🛰️ STEP 1 FIX: THE BROADCAST HEARTBEAT
 * Runs every 1 second to push data from backend services to frontend clients.
 */
setInterval(() => {
  if (!wss || wss.clients.size === 0) return;

  wss.clients.forEach((client) => {
    // Only speak to open sockets
    if (client.readyState !== 1) return; 

    try {
      const tenantId = client.tenantId || "default";

      // CHANNEL: MARKET -> Sends live price data
      if (client.channel === "market") {
        const marketData = marketEngine.getMarketSnapshot(tenantId);
        client.send(JSON.stringify({ 
          type: "market", 
          data: marketData 
        }));
      }

      // CHANNEL: PAPER -> Sends account equity, positions, and trades
      if (client.channel === "paper") {
        const paperSnapshot = paperTrader.snapshot(tenantId);
        client.send(JSON.stringify({ 
          type: "paper", 
          snapshot: paperSnapshot 
        }));
      }
    } catch (err) {
      console.error("[WS_PUSH_ERR]:", err.message);
    }
  });
}, 1000);

/* ================= 🏁 STARTUP ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 AUTOSHIELD v33.0 BROADCAST ACTIVE ON PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('SHIELDED ERROR:', err.stack));
