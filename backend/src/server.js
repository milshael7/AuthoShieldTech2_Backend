// frontend/src/pages/TradingRoom.jsx
// ============================================================
// TRADING ROOM — PRODUCTION WS CONNECTED (RENDER SAFE)
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";
import { getSavedUser, getToken } from "../lib/api.js";
import { Navigate } from "react-router-dom";

function buildWsUrl() {
  const token = getToken();
  if (!token) return null;

  const base = import.meta.env.VITE_API_BASE;
  if (!base) return null;

  const wsBase = base
    .replace("https://", "wss://")
    .replace("http://", "ws://");

  return `${wsBase}/ws/market?token=${encodeURIComponent(token)}`;
}

function timeframeToSeconds(tf) {
  switch (tf) {
    case "1M": return 60;
    case "5M": return 300;
    case "15M": return 900;
    case "30M": return 1800;
    case "1H": return 3600;
    case "4H": return 14400;
    case "1D": return 86400;
    default: return 60;
  }
}

export default function TradingRoom() {

  const user = getSavedUser();
  const role = String(user?.role || "").toLowerCase();
  if (!user || (role !== "admin" && role !== "manager")) {
    return <Navigate to="/admin" replace />;
  }

  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const containerRef = useRef(null);
  const candleDataRef = useRef([]);
  const wsRef = useRef(null);

  const [timeframe] = useState("1M");
  const [activeTab, setActiveTab] = useState("positions");
  const [panelOpen, setPanelOpen] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("CONNECTING");

  const [positions] = useState([]);
  const [orders] = useState([]);
  const [news] = useState([]);
  const [signal] = useState({
    side: "BUY",
    confidence: 92,
    reason: "Bullish structure confirmed"
  });

  // ================= CHART INIT =================

  useEffect(() => {
    if (!containerRef.current) return;

    chartRef.current = createChart(containerRef.current, {
      layout: {
        background: { color: "#0f1626" },
        textColor: "#d1d5db",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,.1)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,.1)",
        timeVisible: true,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    seriesRef.current = chartRef.current.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      borderVisible: true,
      wickVisible: true,
    });

    seedCandles();

    return () => chartRef.current?.remove();
  }, []);

  function seedCandles() {
    const now = Math.floor(Date.now() / 1000);
    const tf = timeframeToSeconds(timeframe);
    const candles = [];
    let base = 1.1000;

    for (let i = 200; i > 0; i--) {
      const time = now - i * tf;
      const open = base;
      const close = open + (Math.random() - 0.5) * 0.01;
      const high = Math.max(open, close);
      const low = Math.min(open, close);
      candles.push({ time, open, high, low, close });
      base = close;
    }

    candleDataRef.current = candles;
    seriesRef.current.setData(candles);
  }

  function updateCandle(price) {
    if (!seriesRef.current) return;

    const tfSeconds = timeframeToSeconds(timeframe);
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / tfSeconds) * tfSeconds;

    const last = candleDataRef.current[candleDataRef.current.length - 1];
    if (!last) return;

    if (last.time === bucket) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      seriesRef.current.update({ ...last });
    } else {
      const newCandle = {
        time: bucket,
        open: last.close,
        high: price,
        low: price,
        close: price,
      };
      candleDataRef.current.push(newCandle);
      seriesRef.current.update(newCandle);
    }
  }

  // ================= WEBSOCKET =================

  useEffect(() => {

    const url = buildWsUrl();
    if (!url) return;

    let ws;

    function connect() {
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("CONNECTED");
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "tick") {
          updateCandle(Number(data.price));
        }
      };

      ws.onclose = () => {
        setConnectionStatus("RECONNECTING");
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => ws?.close();

  }, []);

  // ================= UI =================

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0a0f1c", color: "#fff" }}>

      <div style={{ width: 60, background: "#111827" }} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20 }}>

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <strong>EURUSD • {timeframe} • LIVE</strong>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              WS: {connectionStatus}
            </div>
          </div>

          <button
            onClick={() => setPanelOpen(!panelOpen)}
            style={{
              padding: "6px 14px",
              background: "#1e2536",
              border: "1px solid rgba(255,255,255,.1)",
              cursor: "pointer"
            }}
          >
            Execute Order
          </button>
        </div>

        <div style={{
          flex: 1,
          background: "#111827",
          borderRadius: 12,
          overflow: "hidden"
        }}>
          <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        </div>

        <div style={{
          height: 200,
          marginTop: 20,
          background: "#111827",
          borderRadius: 12,
          padding: 16
        }}>

          <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
            {["positions","orders","news","signals"].map(tab => (
              <div
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  cursor: "pointer",
                  fontWeight: activeTab === tab ? 700 : 400
                }}
              >
                {tab.toUpperCase()}
              </div>
            ))}
          </div>

          {activeTab === "positions" && <div>No open positions</div>}
          {activeTab === "orders" && <div>No pending orders</div>}
          {activeTab === "news" && <div>No live news</div>}
          {activeTab === "signals" && (
            <div>
              {signal.side} EURUSD<br />
              Confidence: {signal.confidence}%<br />
              {signal.reason}
            </div>
          )}
        </div>
      </div>

      {panelOpen && (
        <div style={{
          width: 320,
          background: "#111827",
          padding: 20
        }}>
          <strong>AI Engine Status</strong>
          <div style={{ marginTop: 10 }}>State: SCANNING MARKET</div>
          <div>Bias: Bullish</div>
          <div>Confidence: 82%</div>
          <div>Trades Today: 3 / 5</div>
        </div>
      )}
    </div>
  );
}
