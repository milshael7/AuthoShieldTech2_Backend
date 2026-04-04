// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.0 (DECOUPLED & ENGINE-READY)
// FILE: backend/src/server.js
// ==========================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const { verify } = require("./lib/jwt");

// Service Imports
const marketEngine = require("./services/marketEngine");
const engineCore = require("./engine/engineCore");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
// ... add your other routes here ...

const server = http.createServer(app);

/* ================= ENGINE BOOT ================= */
// We no longer need the 1s Loop here. 
// marketEngine.js now triggers the AI Heartbeat automatically.
console.log("🧠 AI Engine Linked to Market Feed...");

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  try {
    // Robust Token Extraction
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "market";

    if (!token) throw new Error("Missing Token");
    const payload = verify(token, "access");
    
    ws.tenantId = String(payload.companyId || payload.id);
    ws.channel = channel;
    ws.isAlive = true;

    // Ensure engine state exists for this user
    marketEngine.registerTenant(ws.tenantId);

    ws.on("pong", () => (ws.isAlive = true));
    console.log(`🔌 WS Connected: ${ws.tenantId} on [${ws.channel}]`);

  } catch (err) {
    console.error("WS Auth Error:", err.message);
    ws.terminate();
  }
});

/* ================= BROADCAST LOOPS ================= */

// Market Data Loop (Matches the Engine's 500ms heartbeat)
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
  const msg = JSON.stringify({ 
    channel: "paper", 
    type: "trade", 
    trade, 
    ts: Date.now() 
  });

  wss.clients.forEach((ws) => {
    if (ws.channel === "paper" && String(ws.tenantId) === String(tenantId)) {
      if (ws.readyState === 1) ws.send(msg);
    }
  });
};

/* ================= RAILWAY SAFETY ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 AUTOSHIELD v32.0 ONLINE ON PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('SYSTEM CRASH PREVENTED:', err.message));
