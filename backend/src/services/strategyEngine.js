import React, { useEffect, useRef, useState, useMemo } from "react";
import TerminalChart from "../components/TerminalChart";
import OrderPanel from "../components/OrderPanel";
import AIBehaviorPanel from "../components/AIBehaviorPanel";
import { getToken } from "../lib/api.js";

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/+$/, "");
const SYMBOL = "BTCUSDT";

const CANDLE_SECONDS = 60;
const MAX_CANDLES = 500;

/* ================= GLOBAL CACHE ================= */

if (!window.__TRADING_CACHE__) {
  window.__TRADING_CACHE__ = {
    candles: [],
    lastCandle: null
  };
}

function storageKey(){
  return `trading_candles_${SYMBOL}`;
}

function loadPersisted(){
  try{
    const raw = localStorage.getItem(storageKey());
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }catch{
    return [];
  }
}

function savePersisted(candles){
  try{
    localStorage.setItem(
      storageKey(),
      JSON.stringify(candles.slice(-MAX_CANDLES))
    );
  }catch{}
}

function mergeHistory(existing,incoming){

  if(!existing.length) return incoming;

  const map = new Map();

  existing.forEach(c => map.set(c.time,c));
  incoming.forEach(c => map.set(c.time,c));

  return Array.from(map.values())
    .sort((a,b)=>a.time-b.time)
    .slice(-MAX_CANDLES);
}

function toNumber(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function TradingRoom(){

  const marketWsRef = useRef(null);
  const paperWsRef = useRef(null);

  const marketReconnectRef = useRef(null);
  const paperReconnectRef = useRef(null);

  const lastCandleRef = useRef(null);
  const engineStartRef = useRef(null);

  const [engineAlive,setEngineAlive] = useState(false);

  const [candles,setCandles] = useState([]);
  const [price,setPrice] = useState(null);

  const [equity,setEquity] = useState(0);
  const [wallet,setWallet] = useState({usd:0,btc:0});
  const [position,setPosition] = useState(null);

  const [trades,setTrades] = useState([]);
  const [decisions,setDecisions] = useState([]);

  const [memory,setMemory] = useState(null);

  const [engineUptime,setEngineUptime] = useState("0s");

  const [aiControl,setAiControl] = useState({
    enabled:true,
    tradingMode:"paper",
    strategyMode:"Balanced"
  });

/* ================= RESTORE CANDLES ================= */

  useEffect(()=>{

    const cache = window.__TRADING_CACHE__;
    const persisted = loadPersisted();

    const next = cache.candles.length ? cache.candles : persisted;

    const last = cache.lastCandle || next[next.length-1] || null;

    lastCandleRef.current = last;

    setCandles(next);

  },[]);

/* ================= LOAD MEMORY ================= */

  async function loadMemory(){

    const token=getToken();
    if(!token || !API_BASE) return;

    try{

      const res=await fetch(
        `${API_BASE}/api/brain/snapshot`,
        {headers:{Authorization:`Bearer ${token}`}}
      );

      const data=await res.json();

      if(data) setMemory(data);

    }catch{}

  }

/* ================= LOAD CONFIG ================= */

  useEffect(()=>{

    async function loadConfig(){

      const token=getToken();
      if(!token || !API_BASE) return;

      try{

        const res=await fetch(
          `${API_BASE}/api/ai/config`,
          {headers:{Authorization:`Bearer ${token}`}}
        );

        const data=await res.json();

        if(data?.config){
          setAiControl(data.config);
        }

      }catch{}

    }

    loadConfig();
    loadMemory();

  },[]);

/* ================= ENGINE UPTIME ================= */

  useEffect(()=>{

    const timer=setInterval(()=>{

      if(!engineStartRef.current) return;

      const diff=Date.now()-engineStartRef.current;

      const sec=Math.floor(diff/1000)%60;
      const min=Math.floor(diff/60000)%60;
      const hr=Math.floor(diff/3600000);

      setEngineUptime(`${hr}h ${min}m ${sec}s`);

    },1000);

    return ()=>clearInterval(timer);

  },[]);

/* ================= LOAD HISTORY ================= */

  async function loadHistory(){

    const token=getToken();
    if(!token || !API_BASE) return;

    try{

      const res=await fetch(
        `${API_BASE}/api/market/candles/${SYMBOL}?limit=${MAX_CANDLES}`,
        {headers:{Authorization:`Bearer ${token}`}}
      );

      const data=await res.json();

      if(!data?.ok || !Array.isArray(data.candles)) return;

      const formatted=data.candles
        .map(c=>({
          time:Number(c.time),
          open:Number(c.open),
          high:Number(c.high),
          low:Number(c.low),
          close:Number(c.close)
        }))
        .filter(c=>Number.isFinite(c.time))
        .slice(-MAX_CANDLES);

      if(!formatted.length) return;

      setCandles(prev => {

        const merged = mergeHistory(prev, formatted);

        const last = merged[merged.length-1];

        lastCandleRef.current = last;

        window.__TRADING_CACHE__.candles = merged;
        window.__TRADING_CACHE__.lastCandle = last;

        savePersisted(merged);

        return merged;

      });

    }catch{}
  }

  useEffect(()=>{loadHistory()},[]);

/* ================= CANDLE UPDATE ================= */

  function updateCandles(priceNow){

    if(!Number.isFinite(priceNow)) return;

    const now=Math.floor(Date.now()/1000);
    const candleTime=Math.floor(now/CANDLE_SECONDS)*CANDLE_SECONDS;

    const last=lastCandleRef.current;

    setCandles(prev=>{

      let next;
      let nextLast;

      if(!last || last.time!==candleTime){

        nextLast={
          time:candleTime,
          open:priceNow,
          high:priceNow,
          low:priceNow,
          close:priceNow
        };

        next=[...prev.slice(-MAX_CANDLES),nextLast];

      }else{

        nextLast={
          ...last,
          high:Math.max(last.high,priceNow),
          low:Math.min(last.low,priceNow),
          close:priceNow
        };

        next=[...prev];
        next[next.length-1]=nextLast;

      }

      lastCandleRef.current=nextLast;

      window.__TRADING_CACHE__.candles = next;
      window.__TRADING_CACHE__.lastCandle = nextLast;

      savePersisted(next);

      return next;

    });

  }

/* ================= MARKET WS ================= */

  function connectMarket(){

    const token=getToken();
    if(!token || !API_BASE) return;

    const url=new URL(API_BASE);
    const protocol=url.protocol==="https:"?"wss:":"ws:";

    const ws=new WebSocket(
      `${protocol}//${url.host}/ws?channel=market&token=${encodeURIComponent(token)}`
    );

    marketWsRef.current=ws;

    ws.onmessage=(msg)=>{

      try{

        const packet=JSON.parse(msg.data);

        if(packet.channel!=="market") return;

        const market=packet?.data?.[SYMBOL];
        if(!market) return;

        const p=toNumber(market.price);
        if(p===null) return;

        setPrice(p);

        updateCandles(p);

      }catch{}

    };

  }

/* ================= PAPER WS ================= */

  function connectPaper(){

    const token=getToken();
    if(!token || !API_BASE) return;

    const url=new URL(API_BASE);
    const protocol=url.protocol==="https:"?"wss:":"ws:";

    const ws=new WebSocket(
      `${protocol}//${url.host}/ws?channel=paper&token=${encodeURIComponent(token)}`
    );

    paperWsRef.current=ws;

    ws.onmessage=(msg)=>{

      try{

        const data=JSON.parse(msg.data);

        if(data.channel!=="paper") return;

        if(!engineStartRef.current){
          engineStartRef.current=data.engineStart||Date.now();
        }

        if(data.snapshot){
          setEngineAlive(true);
        }

        const snap=data.snapshot||{};

        setEquity(Number(snap.equity||0));

        setWallet({
          usd:Number(snap.cashBalance||0),
          btc:Number(snap.position?.qty||0)
        });

        setPosition(snap.position||null);
        setTrades(snap.trades||[]);
        setDecisions(snap.decisions||[]);

      }catch{}

    };

  }

  useEffect(()=>{

    connectMarket();
    connectPaper();

  },[]);

/* ================= AI METRICS ================= */

  const aiConfidence=useMemo(()=>{

    if(!decisions.length) return 0.2;

    const total=decisions.reduce(
      (s,d)=>s+Number(d.confidence||0),0
    );

    return total/decisions.length;

  },[decisions]);

/* ================= ENGINE STATUS ================= */

  const engineStatus =
    engineAlive || engineStartRef.current
      ? "RUNNING"
      : "STARTING";

/* ================= UI ================= */

  return(

    <div style={{display:"flex",flex:1,background:"#0a0f1c",color:"#fff"}}>

      <div style={{flex:1,padding:20}}>

        <div style={{fontWeight:700}}>{SYMBOL}</div>

        <div style={{opacity:.7}}>
          Live Price: {price ? price.toLocaleString() : "Loading"}
        </div>

        <TerminalChart
          candles={candles}
          trades={trades}
          pnlSeries={trades}
        />

        <div style={{marginTop:20}}>
          <AIBehaviorPanel
            trades={trades}
            decisions={decisions}
            memory={memory}
          />
        </div>

      </div>

      <div style={{width:240}}>
        <OrderPanel symbol={SYMBOL} price={price}/>
      </div>

      <div style={{
        width:240,
        padding:16,
        background:"#111827",
        overflowY:"auto"
      }}>

        <h3>AI Engine</h3>

        <div>Status: {engineStatus}</div>

        <div>Engine Uptime: {engineUptime}</div>

        <div style={{marginTop:10}}>
          Equity: ${equity.toFixed(2)}
        </div>

        <div>Cash: ${wallet.usd.toFixed(2)}</div>

        <div style={{marginTop:10}}>
          Trades: {trades.length}
        </div>

        <div>
          AI Confidence: {(aiConfidence*100).toFixed(0)}%
        </div>

      </div>

    </div>

  );

}
