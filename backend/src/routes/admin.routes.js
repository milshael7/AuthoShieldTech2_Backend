// frontend/src/pages/Dashboard.jsx
// Enterprise Admin Executive Dashboard — Phase 5 + 6
// Financial Intelligence + Predictive + Compliance + Live Status

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";

/* =========================================================
   MAIN DASHBOARD
========================================================= */

export default function Dashboard() {

  const [loading,setLoading]=useState(true);

  const [metrics,setMetrics]=useState(null);
  const [risk,setRisk]=useState(null);
  const [overlay,setOverlay]=useState(null);
  const [predictive,setPredictive]=useState(null);
  const [complianceReport,setComplianceReport]=useState(null);
  const [complianceHistory,setComplianceHistory]=useState([]);

  const [liveMode,setLiveMode]=useState(false);
  const [lastUpdated,setLastUpdated]=useState(null);

  /* ================= LOAD ================= */

  async function loadAll(){
    try{
      const [
        m,
        r,
        o,
        p,
        cr,
        ch
      ]=await Promise.all([
        api.adminMetrics(),
        api.adminExecutiveRisk(),
        api.adminRevenueRefundOverlay(90),
        api.adminPredictiveChurn(),
        api.adminComplianceReport(),
        api.adminComplianceHistory(20)
      ]);

      setMetrics(m?.metrics||null);
      setRisk(r?.executiveRisk||null);
      setOverlay(o||null);
      setPredictive(p?.predictiveChurn||null);
      setComplianceReport(cr?.complianceReport||null);
      setComplianceHistory(ch?.history||[]);

      setLastUpdated(new Date());

    }catch(e){
      console.error("Executive load error",e);
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{
    loadAll();
  },[]);

  useEffect(()=>{
    if(!liveMode) return;
    const id=setInterval(loadAll,30000);
    return()=>clearInterval(id);
  },[liveMode]);

  /* =========================================================
     DERIVED EXECUTIVE CALCULATIONS
  ========================================================= */

  const stability=useMemo(()=>{
    if(!metrics||!risk||!overlay) return null;

    const refundsRatio=risk?.signals?.refundsRatio||0;
    const disputesRatio=risk?.signals?.disputesRatio||0;
    const churn=metrics?.churnRate||0;
    const riskIndex=risk?.riskIndex||0;

    let weighted=
      (refundsRatio*100*0.2)+
      (disputesRatio*100*0.25)+
      (churn*100*0.2)+
      (riskIndex*0.35);

    weighted=Math.min(100,Math.max(0,weighted));

    const score=Math.max(0,100-weighted);

    let level="STABLE";
    if(score<40) level="CRITICAL";
    else if(score<60) level="ELEVATED";
    else if(score<80) level="WATCH";

    return {score:Number(score.toFixed(1)),level};
  },[metrics,risk,overlay]);

  const platformStatus=useMemo(()=>{
    if(!risk||!predictive) return "LOADING";

    if(risk.level==="CRITICAL"||predictive.level==="CRITICAL")
      return "CRITICAL EXPOSURE";

    if(risk.level==="ELEVATED"||predictive.level==="ELEVATED")
      return "ELEVATED RISK";

    return "PLATFORM SECURE";
  },[risk,predictive]);

  if(loading){
    return <div style={{padding:28}}>Loading Executive Intelligence...</div>;
  }

  return(
    <div style={{padding:28,display:"flex",flexDirection:"column",gap:22}}>

      {/* STATUS BANNER */}

      <div style={{
        padding:14,
        borderRadius:14,
        background:
          platformStatus==="CRITICAL EXPOSURE"
          ? "#ff3b3022"
          : platformStatus==="ELEVATED RISK"
          ? "#ff950022"
          : "#16c78422",
        border:"1px solid rgba(255,255,255,.08)",
        fontWeight:800
      }}>
        {platformStatus}
        {liveMode && <span style={{marginLeft:10,fontSize:12}}>● LIVE</span>}
      </div>

      {/* HEADER */}

      <div style={{display:"flex",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:12,opacity:.6}}>EXECUTIVE INTELLIGENCE LAYER</div>
          <div style={{fontSize:22,fontWeight:900}}>Financial & Compliance Command</div>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button style={btnGhost} onClick={()=>setLiveMode(v=>!v)}>
            {liveMode?"Disable Live":"Enable Live"}
          </button>
          <button style={btnPrimary} onClick={loadAll}>Refresh</button>
        </div>
      </div>

      {/* STABILITY INDEX */}

      {stability&&(
        <Panel title="Revenue Stability Index">
          <div style={{fontSize:40,fontWeight:900}}>
            {stability.score}
          </div>
          <div style={{marginTop:6,fontWeight:800}}>
            {stability.level}
          </div>
          <Meter value={stability.score}/>
        </Panel>
      )}

      {/* PREDICTIVE CHURN */}

      {predictive&&(
        <Panel title="Predictive Churn Forecast">
          <div style={{fontSize:30,fontWeight:900}}>
            {predictive.score}
          </div>
          <div style={{marginTop:6}}>
            Risk Level: {predictive.level}
          </div>
          <Meter value={predictive.score}/>
        </Panel>
      )}

      {/* REVENUE OVERLAY */}

      {overlay?.totals&&(
        <Panel title="Revenue vs Refund / Dispute (90d)">
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
            <MiniStat label="Revenue" value={`$${overlay.totals.revenue}`}/>
            <MiniStat label="Refunds" value={`$${overlay.totals.refunds}`}/>
            <MiniStat label="Disputes" value={`$${overlay.totals.disputes}`}/>
          </div>
        </Panel>
      )}

      {/* COMPLIANCE */}

      <Panel title="Compliance Integrity">
        <div style={{marginBottom:10}}>
          Snapshots Stored: {complianceHistory.length}
        </div>
        <div>
          Latest Audit:
          {complianceHistory[0]?.time
            ? new Date(complianceHistory[0].time).toLocaleString()
            : "N/A"}
        </div>
      </Panel>

      {lastUpdated&&(
        <div style={{fontSize:12,opacity:.5}}>
          Last Updated: {lastUpdated.toLocaleTimeString()}
        </div>
      )}

    </div>
  );
}

/* =========================================================
   COMPONENTS
========================================================= */

function Panel({title,children}){
  return(
    <div style={{
      padding:18,
      borderRadius:14,
      background:"rgba(255,255,255,.03)",
      border:"1px solid rgba(255,255,255,.08)"
    }}>
      <div style={{fontWeight:900,marginBottom:12}}>
        {title}
      </div>
      {children}
    </div>
  );
}

function MiniStat({label,value}){
  return(
    <div>
      <div style={{fontSize:12,opacity:.6}}>{label}</div>
      <div style={{fontWeight:900,fontSize:18}}>
        {value}
      </div>
    </div>
  );
}

function Meter({value}){
  return(
    <div style={{
      marginTop:10,
      height:12,
      borderRadius:999,
      background:"rgba(255,255,255,.06)",
      overflow:"hidden"
    }}>
      <div style={{
        width:`${value}%`,
        height:"100%",
        background:
          value<40?"#ff3b30":
          value<60?"#ff9500":
          value<80?"#f5b400":
          "#16c784"
      }}/>
    </div>
  );
}

const btnPrimary={
  padding:"8px 14px",
  borderRadius:10,
  background:"#fff",
  color:"#000",
  fontWeight:800,
  border:"none",
  cursor:"pointer"
};

const btnGhost={
  padding:"8px 14px",
  borderRadius:10,
  background:"transparent",
  color:"#fff",
  border:"1px solid rgba(255,255,255,.2)",
  cursor:"pointer"
};
