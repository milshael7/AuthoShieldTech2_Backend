// ==========================================================
// 🐙 KRAKEN SERVICE — v12.1 (RESILIENT DATA PUMP)
// FILE: backend/src/services/krakenService.js
// ==========================================================

const WebSocket = require('ws');
const engineCore = require('../engine/engineCore');
const stateStore = require('../engine/stateStore');

/* ================= CONFIG ================= */
const KRAKEN_WS_URL = "wss://ws.kraken.com";
const SUBSCRIPTION_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];

let socket = null;
let reconnectTimer = null;
let isConnecting = false;

/**
 * 🛰️ INITIALIZE UPLINK
 * Connects to Kraken Public WS for real-time price feeds.
 */
function initKrakenUplink() {
  if (isConnecting) return;
  isConnecting = true;

  console.log("[KRAKEN]: Initializing Secure Uplink...");
  socket = new WebSocket(KRAKEN_WS_URL);

  socket.on('open', () => {
    isConnecting = false;
    console.log("[KRAKEN]: Uplink Established. Subscribing to Ticker feeds...");
    
    // Subscribe to Ticker for all configured symbols
    const payload = {
      event: "subscribe",
      pair: SUBSCRIPTION_SYMBOLS,
      subscription: { name: "ticker" }
    };
    socket.send(JSON.stringify(payload));
  });

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Kraken Ticker format: [channelID, data, channelName, pair]
      if (Array.isArray(msg) && msg[2] === "ticker") {
        const rawPair = msg[3];
        const symbol = rawPair.replace("/", ""); // BTC/USD -> BTCUSD
        const price = Number(msg[1].c[0]);      // 'c' is the last closed trade [price, lot]

        if (!price || isNaN(price)) return;

        // 1. Update the State Store (The Truth)
        stateStore.updatePrice("default", symbol, price);

        // 2. Trigger the Engine Core (The Brain)
        engineCore.processTick({
          tenantId: "default",
          symbol,
          price,
          ts: Date.now()
        });
      }
    } catch (err) {
      // Fail silent on parse errors to keep the pump running
    }
  });

  socket.on('error', (err) => {
    console.error("[KRAKEN]: Link Error:", err.message);
  });

  socket.on('close', () => {
    isConnecting = false;
    console.warn("[KRAKEN]: Uplink Severed. Attempting failover in 5s...");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(initKrakenUplink, 5000);
  });
}

/**
 * 🛠️ UTILITY: Manual Heartbeat Check
 */
function getStatus() {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    symbols: SUBSCRIPTION_SYMBOLS,
    timestamp: Date.now()
  };
}

module.exports = {
  initKrakenUplink,
  getStatus
};
