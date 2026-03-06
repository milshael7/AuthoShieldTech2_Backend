// ==========================================================
// Capital Protection Layer
// Prevents oversized trades and capital loss
// ==========================================================

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({

  maxRiskPerTrade:
    Number(process.env.MAX_RISK_PER_TRADE || 0.02), // 2%

  minTradeUsd:
    Number(process.env.MIN_TRADE_USD || 50),

  maxTradeUsd:
    Number(process.env.MAX_TRADE_USD || 100000)

});

/* =========================================================
UTIL
========================================================= */

function safeNum(v,fallback=0){

  const n = Number(v);

  return Number.isFinite(n) ? n : fallback;

}

/* =========================================================
CALCULATE SAFE ORDER SIZE
========================================================= */

function computeSafeTradeSize({

  balanceUsd,
  requestedRiskPct,
  price

}){

  balanceUsd = safeNum(balanceUsd);
  price = safeNum(price);
  requestedRiskPct = safeNum(requestedRiskPct,CONFIG.maxRiskPerTrade);

  if(balanceUsd <= 0) return null;
  if(price <= 0) return null;

  /* ================= MAX RISK ================= */

  const maxAllowedRisk =
    balanceUsd * CONFIG.maxRiskPerTrade;

  /* ================= REQUESTED SIZE ================= */

  const requestedUsd =
    balanceUsd * requestedRiskPct;

  /* ================= SAFE CLAMP ================= */

  let safeUsd =
    clamp(
      requestedUsd,
      CONFIG.minTradeUsd,
      maxAllowedRisk
    );

  /* ================= ABSOLUTE LIMIT ================= */

  safeUsd =
    clamp(
      safeUsd,
      CONFIG.minTradeUsd,
      CONFIG.maxTradeUsd
    );

  if(safeUsd < CONFIG.minTradeUsd)
    return null;

  const qty = safeUsd / price;

  if(!Number.isFinite(qty) || qty <= 0)
    return null;

  return{
    usd:safeUsd,
    qty
  };

}

/* =========================================================
VALIDATE ORDER
========================================================= */

function validateOrder({

  balanceUsd,
  price,
  riskPct

}){

  const result =
    computeSafeTradeSize({
      balanceUsd,
      requestedRiskPct:riskPct,
      price
    });

  if(!result){

    return{
      allow:false,
      reason:"Trade below minimum size"
    };

  }

  return{
    allow:true,
    usd:result.usd,
    qty:result.qty
  };

}

/* ========================================================= */

module.exports={
  validateOrder
};
