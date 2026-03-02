// frontend/src/pages/TradingRoom.jsx
// ============================================================
// TRADING ROOM — REAL BACKEND LIVE STREAM CONNECTED
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";
import { getSavedUser, getToken } from "../lib/api.js";
import { Navigate } from "react-router-dom";

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
  const wsRef = useRef(null);
  const candleDataRef = useRef([]);

  const [timeframe, setTimeframe] = useState("1M");
  const [panelOpen, setPanelOpen] = useState(true);
  const [activeTab, setActiveTab] = useState("positions");

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
    });

    return () => chartRef.current?.remove();
  }, []);

  // ================= WEBSOCKET CONNECT =================

  useEffect(() => {

    const token = getToken();
    if (!token) return;

    const ws = new WebSocket(`ws://localhost:5000/ws/market?token=${token}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "tick") {
        updateCandle(data.price, data.ts);
      }
    };

    return () => ws.close();

  }, [timeframe]);

  // ================= CANDLE ENGINE =================

  function updateCandle(price, timestamp) {

    const tfSeconds = timeframeToSeconds(timeframe);
    const bucket = Math.floor(timestamp / 1000 / tfSeconds) * tfSeconds;

    const last = candleDataRef.current[candleDataRef.current.length - 1];

    if (!last || last.time !== bucket) {
      const newCandle = {
        time: bucket,
        open: last ? last.close : price,
        high: price,
        low: price,
        close: price
      };

      candleDataRef.current.push(newCandle);
      seriesRef.current.update(newCandle);
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;

      seriesRef.current.update(last);
    }

    chartRef.current.timeScale().scrollToRealTime();
  }

  // ================= UI =================

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0a0f1c", color: "#fff" }}>

      <div style={{ width: 60, background: "#111827" }} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20 }}>

        {/* HEADER */}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>
            EURUSD • LIVE
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

        {/* TIMEFRAME BUTTONS */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {["1M","5M","15M","30M","1H","4H","1D"].map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              style={{
                padding: "4px 10px",
                background: timeframe === tf ? "#2563eb" : "transparent",
                border: "1px solid rgba(255,255,255,.1)",
                color: "#fff",
                cursor: "pointer"
              }}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* CHART */}
        <div style={{
          flex: 1,
          background: "#111827",
          borderRadius: 12,
          overflow: "hidden",
        }}>
          <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        </div>

        {/* BOTTOM PANEL */}
        <div style={{
          height: 220,
          marginTop: 20,
          background: "#111827",
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,.08)",
          display: "flex",
          flexDirection: "column"
        }}>
          <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
            {["positions","orders","news","signals"].map(tab => (
              <div
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "12px 18px",
                  cursor: "pointer",
                  background: activeTab === tab ? "#1e2536" : "transparent"
                }}
              >
                {tab.toUpperCase()}
              </div>
            ))}
          </div>

          <div style={{ flex: 1, padding: 16 }}>
            {activeTab === "positions" && <div>No open positions</div>}
            {activeTab === "orders" && <div>No pending orders</div>}
            {activeTab === "news" && <div>No live news</div>}
            {activeTab === "signals" && <div>Waiting for AI signal...</div>}
          </div>
        </div>

      </div>

      {panelOpen && (
        <div style={{
          width: 360,
          background: "#111827",
          borderLeft: "1px solid rgba(255,255,255,.08)",
          padding: 20
        }}>
          <div style={{ fontWeight: 700 }}>AI Engine Status</div>
          <div style={{ marginTop: 10 }}>State: LIVE STREAM ACTIVE</div>
        </div>
      )}

    </div>
  );
}
