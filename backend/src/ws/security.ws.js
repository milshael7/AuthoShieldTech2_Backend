// backend/src/ws/security.ws.js
// ==========================================================
// SECURITY WEBSOCKET — QUIET MODE v1
// EVENT-DRIVEN • NO POLLING • NO CHATTER
// EMITS ONLY REAL SECURITY SIGNALS
// ==========================================================

const { WebSocketServer } = require("ws");
const { verify } = require("../lib/jwt");
const { readDb } = require("../lib/db");
const sessionAdapter = require("../lib/sessionAdapter");

function close(ws) {
  try { ws.close(); } catch {}
}

function createSecurityWS(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws/security",
  });

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (!token) return close(ws);

      const payload = verify(token, "access");
      if (!payload?.id || !payload?.jti) return close(ws);
      if (sessionAdapter.isRevoked(payload.jti)) return close(ws);

      const db = readDb();
      const user = (db.users || []).find(
        (u) => String(u.id) === String(payload.id)
      );
      if (!user) return close(ws);

      if (
        Number(payload.tokenVersion || 0) !==
        Number(user.tokenVersion || 0)
      ) {
        sessionAdapter.revokeToken(payload.jti);
        return close(ws);
      }

      // Attach identity (no broadcasts yet)
      ws.userId = user.id;
      ws.companyId = user.companyId || null;

    } catch {
      return close(ws);
    }
  });

  // Heartbeat — quiet, slow, defensive
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  return wss;
}

module.exports = { createSecurityWS };
