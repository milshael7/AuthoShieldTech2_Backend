// ==========================================================
// 📡 SOCKET CONTROLLER — v15.0 (UNISON BROADCASTER)
// FILE: backend/src/ws/socketController.js
// ==========================================================

const { Server } = require("socket.io");
const stateStore = require("../engine/stateStore");
const { verifyToken } = require("../services/authService");

let io = null;

/**
 * 🛠️ INITIALIZE SOCKET SERVER
 * Handles auth handshake and room joining.
 */
function initSocketServer(server) {
  io = new Server(server, {
    cors: {
      origin: "*", // Adjust for production Vercel URL later
      methods: ["GET", "POST"]
    }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.query.token;
      const user = await verifyToken(token);
      
      if (!user) return next(new Error("AUTH_FAILED"));
      
      // Attach user info to the socket for room routing
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("AUTH_ERROR"));
    }
  });

  io.on("connection", (socket) => {
    const tenantId = socket.user.companyId || "default";
    console.log(`[WS]: Uplink Established for Tenant: ${tenantId}`);

    // Join a room specific to their company so they don't see others' trades
    socket.join(tenantId);

    // Send immediate initial state so Dashboard isn't empty on load
    const initialSnapshot = stateStore.getSnapshot(tenantId);
    socket.emit("state_update", initialSnapshot);

    socket.on("disconnect", () => {
      console.log(`[WS]: Link Severed for ${socket.id}`);
    });
  });

  /* ================= GLOBAL HOOKS ================= */

  /**
   * 🛰️ GLOBAL BROADCAST: TRADE EVENT
   * Called by executionEngine.js via global.broadcastTrade
   */
  global.broadcastTrade = (tradeData, tenantId = "default") => {
    if (!io) return;
    io.to(tenantId).emit("trade_executed", tradeData);
  };

  /**
   * 🛰️ GLOBAL BROADCAST: SECURITY ALERT
   * Called by Security logic
   */
  global.broadcastSecurity = (alert, tenantId = "default") => {
    if (!io) return;
    io.to(tenantId).emit("integrity_alert", alert);
  };
}

/**
 * 💓 STATE HEARTBEAT
 * Pushes the entire state snapshot every 1s if there's activity.
 */
setInterval(() => {
  if (!io) return;
  
  // In a multi-tenant setup, we loop through active rooms
  // For now, we blast the 'default' or active company state
  const tenants = Array.from(io.sockets.adapter.rooms.keys());
  
  tenants.forEach(tenantId => {
    // Only send to rooms that are actually Company IDs (skip socket IDs)
    if (tenantId.length > 20 || tenantId === "default") {
       const snapshot = stateStore.getSnapshot(tenantId);
       io.to(tenantId).emit("state_update", snapshot);
    }
  });
}, 1000);

module.exports = { initSocketServer };
