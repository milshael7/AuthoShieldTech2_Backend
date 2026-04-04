// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.5 (STEALTH & BOOT-FIXED)
// FILE: backend/src/server.js
// ==========================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const { verify } = require("./lib/jwt");

// Service & Analytics Imports
const marketEngine = require("./services/marketEngine");
const users = require("./users/user.service");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= STEALTH EXECUTION LAYER ================= */
// Global function so the Brain can call it from anywhere
global.lastConfidence = 0;

global.executeStealthTrade = async function(side, price, confidence, tenantId = 'default') {
  const isLive = process.env.NODE_ENV === 'production' && process.env.LIVE_TRADING === 'true';
  global.lastConfidence = confidence;
  
  console.log(`[AI]: Signal | Side: ${side} | Conf: ${confidence}%`);
  
  // Dynamic require to prevent "app is not defined" boot crashes
  const engineCore = require("./engine/engineCore");

  if (confidence > 25) {
    return isLive ? "LIVE_STUB" : engineCore.processTick({ tenantId, symbol: "BTCUSDT", price });
  }
  return "WAITING";
};

/* ================= THE "HAPPY PERSON" DASHBOARD ================= */
app.get("/", (req, res) => {
  // We use a safe check here so the page loads even if the engine is warming up
  let stats = { accuracy: "N/A", trades: 0 };
  try {
    const engineCore = require("./engine/engineCore");
    stats = engineCore.getLearningStats() || stats;
  } catch (e) {
    console.log("Engine warming up...");
  }

  res.send(`
    <div style="text-align: center; font-family: 'Courier New', monospace; padding: 50px; background: #0a0a0a; color: #00ff88; min-height: 100vh;">
      <h1 style="font-size: 60px; margin-bottom: 10px;">😊</h1>
      <h1 style="letter-spacing: 2px; border-bottom: 2px solid #333; display: inline-block; padding-bottom: 10px;">AUTOSHIELD v32.5</h1>
      <div style="margin: 30px auto; width: 320px; border: 1px solid #00ff88; padding: 20px; border-radius: 15px; background: #111;">
        <h2 style="color: #fff; margin-top: 0;">STEALTH ACTIVE</h2>
        <p style="color: #888;">AI is currently learning market energy.</p>
        <hr style="border-color: #222;">
        <div style="display: flex; justify-content: space-around;">
          <div><small>CONFIDENCE</small><br/><strong style="font-size: 1.5em;">${global.lastConfidence}%</strong></div>
          <div><small>TRADES</small><br/><strong style="font-size: 1.5em;">${stats.trades}</strong></div>
        </div>
      </div>
      <p style="color: #444;">Render Status: <span style="color: #00ff88;">STABLE</span></p>
    </div>
  `);
});

/* ================= ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes"));

const server = http.createServer(app);

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) { ws.tenantId = "guest"; } 
    else {
      const payload = verify(token, "access");
      ws.tenantId = String(payload.companyId || payload.id);
    }
    ws.channel = url.searchParams.get("channel") || "market";
    marketEngine.registerTenant(ws.tenantId);
  } catch (err) { ws.terminate(); }
});

/* ================= RENDER STARTUP ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 STEALTH ENGINE LIVE | PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('SHIELDED ERROR:', err.message));
