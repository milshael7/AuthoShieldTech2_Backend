// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.4 (ENGINE-START & RENDER-OPTIMIZED)
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
const engineCore = require("./engine/engineCore");
const users = require("./users/user.service");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= THE "HAPPY PERSON" ENGINE START ================= */
// This serves as the landing page for your server URL
app.get("/", (req, res) => {
  res.send(`
    <div style="text-align: center; font-family: sans-serif; padding-top: 50px; background: #121212; color: #00ff88; height: 100vh;">
      <h1 style="font-size: 50px;">😊</h1>
      <h1 style="letter-spacing: 2px;">AUTOSHIELD ENGINE: ONLINE</h1>
      <p style="color: #888;">Core v32.4 is running happily on Render.</p>
      <div style="display: inline-block; padding: 10px 20px; border: 1px solid #00ff88; border-radius: 5px;">
        STATUS: STABLE
      </div>
    </div>
  `);
});

/* ================= ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes"));

const server = http.createServer(app);

/* ================= RENDER BOOTSTRAP ================= */
try {
  users.ensureAdminFromEnv();
} catch (err) {
  console.error("Bootstrap Error:", err.message);
}

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

global.broadcastEngineStatus = function(tenantId, stats) {
  const msg = JSON.stringify({
    channel: "engine_stats",
    data: stats,
    ts: Date.now()
  });

  wss.clients.forEach((ws) => {
    if (ws.readyState === 1 && (String(ws.tenantId) === String(tenantId) || ws.tenantId === 'guest')) {
      ws.send(msg);
    }
  });
};

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "market";

    if (!token) {
      ws.tenantId = "guest"; 
    } else {
      const payload = verify(token, "access");
      ws.tenantId = String(payload.companyId || payload.id);
    }
    
    ws.channel = channel;
    ws.isAlive = true;
    marketEngine.registerTenant(ws.tenantId);
    ws.on("pong", () => (ws.isAlive = true));
  } catch (err) {
    ws.terminate();
  }
});

/* ================= BROADCAST LOOPS ================= */

// Market Data Loop (Relaxed for Render Stability)
setInterval(() => {
  const snapshots = new Map();
  wss.clients.forEach((ws) => {
    if (ws.channel !== "market" || ws.readyState !== 1) return;
    
    if (!snapshots.has(ws.tenantId)) {
      const data = marketEngine.getMarketSnapshot(ws.tenantId);
      snapshots.set(ws.tenantId, JSON.stringify({ 
        channel: "market", data, ts: Date.now() 
      }));
    }
    ws.send(snapshots.get(ws.tenantId));
  });
}, 1000); 

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 AUTOSHIELD v32.4 | ENGINE START PAGE ACTIVE | PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('PREVENTED CRASH:', err.message));
