/* =========================================================
   LIVE ONLINE USER TRACKER
   ========================================================= */

let onlineUsers = 0;

function broadcastOnline() {
  const payload = JSON.stringify({
    type: "online",
    online: onlineUsers,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {}
    }
  });
}
