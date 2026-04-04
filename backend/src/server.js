// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.1 (LIVELY & PERSISTENT)
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
const { analyticsEvents, recordVisit } = require("./services/analyticsEngine"); // FIXED: Import the Lively Bus

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes")); // FIXED: Analytics Route included

const server = http.createServer(app);

/* ================= ENGINE BOOT ================= */
console.log("🧠 AI Engine Linked to Market Feed...");

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

// Global helper to find specific users on WS
const getClientsByTenant = (tenantId, channel) => {
  return Array.from(wss.clients).filter(ws => 
    String(ws.tenantId) === String(tenantId) && 
    ws.channel === channel && 
    ws.readyState === 1
  );
};

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "market";

    if (!token) throw new Error("Missing Token");
    const payload = verify(token, "access");
    
    ws.tenantId = String(payload.companyId || payload.id);
    ws.channel = channel;
    ws.isAlive = true;

    marketEngine.registerTenant(ws.tenantId);

    // FIX: RECORD CONNECTION IN ANALYTICS (Lively History)
    recordVisit({
      type: "WS_CONNECTION",
      path: channel,
      source: "backend",
      ip: req.socket.remoteAddress,
      tenantId: ws.tenantId
    });

    ws.on("pong", () => (ws.isAlive = true));
    console.log(`🔌 WS Connected: ${ws.tenantId} on [${ws.channel}]`);

  } catch (err) {
    console.error("WS Auth Error:", err.message);
    ws.terminate();
  }
});

/* ================= THE LIVELY ANALYTICS BUS ================= */
// Whenever something happens in the "Analytics Room", shout it to the UI
analyticsEvents.on("new_event", (entry) => {
  const msg = JSON.stringify({
    channel: "analytics",
    type: "LIVELY_UPDATE",
    data: entry,
    ts: Date.now()
  });

  wss.clients.forEach((ws) => {
    // Only send analytics updates to users on the analytics channel
    if (ws.channel === "analytics" && ws.readyState === 1) {
      ws.send(msg);
    }
  });
});

/* ================= BROADCAST LOOPS ================= */

// Market Data Loop (500ms)
setInterval(() => {
  const snapshots = new Map();
  wss.clients.forEach((ws) => {
    if (ws.channel !== "market" || ws.readyState !== 1) return;
    
    if (!snapshots.has(ws.tenantId)) {
      const data = marketEngine.getMarketSnapshot(ws.tenantId);
      snapshots.set(ws.tenantId, JSON.stringify({ 
        channel: "market", 
        data, 
        ts: Date.now() 
      }));
    }
    ws.send(snapshots.get(ws.tenantId));
  });
}, 500);

// Global Broadcast helper for Trade Events
global.broadcastTrade = function (trade, tenantId) {
  // RECORD TRADE IN ANALYTICS (Hand-in-Hand persistence)
  recordVisit({
    type: "TRADE_EXECUTION",
    path: "/trading",
    source: "executionEngine",
    duration: trade.duration || 0,
    tenantId
  });

  const msg = JSON.stringify({ 
    channel: "paper", 
    type: "trade", 
    trade, 
    ts: Date.now() 
  });

  getClientsByTenant(tenantId, "paper").forEach(ws => ws.send(msg));
};

/* ================= RAILWAY SAFETY ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 AUTOSHIELD v32.1 ONLINE ON PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('SYSTEM CRASH PREVENTED:', err.message));
