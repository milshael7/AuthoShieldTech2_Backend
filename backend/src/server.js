// ==========================================================
// 🔒 AUTOSHIELD CORE — v32.2 (SYNC-LOCK & RENDER-READY)
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
const users = require("./users/user.service"); // IMPORTED FOR BOOTSTRAP
const { analyticsEvents, recordVisit } = require("./services/analyticsEngine");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/paper", require("./routes/paper.routes")); 
app.use("/api/analytics", require("./routes/analytics.routes"));

const server = http.createServer(app);

/* ================= RENDER BOOTSTRAP (THE FIX) ================= */
// This ensures your "Invalid Credentials" error goes away by 
// re-creating the admin user if Render wiped the database file.
try {
  console.log("🔄 Running User Authority Bootstrap...");
  users.ensureAdminFromEnv();
} catch (err) {
  console.error("❌ Bootstrap Failed:", err.message);
}

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocketServer({ server, path: "/ws" });

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

    // Record Connection in Lively Analytics
    recordVisit({
      type: "WS_CONNECTION",
      path: channel,
      source: "backend",
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
analyticsEvents.on("new_event", (entry) => {
  const msg = JSON.stringify({
    channel: "analytics",
    type: "LIVELY_UPDATE",
    data: entry,
    ts: Date.now()
  });

  wss.clients.forEach((ws) => {
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
  recordVisit({
    type: "TRADE_EXECUTION",
    path: "/trading",
    source: "executionEngine",
    tenantId
  });

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

/* ================= RAILWAY/RENDER SAFETY ================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 AUTOSHIELD v32.2 ONLINE ON PORT ${PORT}`);
});

process.on('uncaughtException', (err) => console.error('SYSTEM CRASH PREVENTED:', err.message));
