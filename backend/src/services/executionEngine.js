// ==========================================================
// EXECUTION ENGINE — PAPER TRADING CORE v2
// Supports LONG + SHORT positions
// ==========================================================

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

/* ========================================================= */

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
POSITION SIZE
========================================================= */

function calculatePositionSize(state, price, riskPct){

  const equity =
    safeNum(state.equity, safeNum(state.cashBalance,0));

  const riskCapital = equity * riskPct;

  if(price <= 0) return 0;

  const qty = riskCapital / price;

  return clamp(qty,0,1e12);
}

/* =========================================================
OPEN POSITION
========================================================= */

function openPosition({
  state,
  symbol,
  price,
  qty,
  side,
  ts
}){

  state.position = {
    symbol,
    side,
    entry: price,
    qty,
    time: ts
  };

  return {
    result:{
      side,
      price,
      qty,
      pnl:0
    }
  };

}

/* =========================================================
CLOSE POSITION
========================================================= */

function closePosition({
  state,
  price,
  ts
}){

  const pos = state.position;

  if(!pos) return null;

  let pnl = 0;

  if(pos.side === "LONG"){
    pnl = (price - pos.entry) * pos.qty;
  }

  if(pos.side === "SHORT"){
    pnl = (pos.entry - price) * pos.qty;
  }

  state.cashBalance =
    safeNum(state.cashBalance) + pnl;

  const trade = {
    side:"CLOSE",
    price,
    qty:pos.qty,
    pnl,
    time:ts
  };

  state.position = null;

  return { result:trade };

}

/* =========================================================
MAIN EXECUTION
========================================================= */

function executePaperOrder({

  tenantId,
  symbol,
  action,
  price,
  riskPct,
  state,
  ts = Date.now()

}){

  if(!state) return null;
  if(!symbol) return null;
  if(!Number.isFinite(price)) return null;

  riskPct = clamp(
    safeNum(riskPct,0.01),
    0.001,
    0.1
  );

  const pos = state.position;

  /* ================= BUY ================= */

  if(action === "BUY"){

    if(pos){

      if(pos.side === "SHORT"){
        return closePosition({state,price,ts});
      }

      return null;
    }

    const qty =
      calculatePositionSize(state,price,riskPct);

    if(qty <= 0) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty,
      side:"LONG",
      ts
    });

  }

  /* ================= SELL ================= */

  if(action === "SELL"){

    if(pos){

      if(pos.side === "LONG"){
        return closePosition({state,price,ts});
      }

      return null;
    }

    const qty =
      calculatePositionSize(state,price,riskPct);

    if(qty <= 0) return null;

    return openPosition({
      state,
      symbol,
      price,
      qty,
      side:"SHORT",
      ts
    });

  }

  /* ================= CLOSE ================= */

  if(action === "CLOSE"){

    if(!pos) return null;

    return closePosition({
      state,
      price,
      ts
    });

  }

  return null;

}

/* ========================================================= */

module.exports = {
  executePaperOrder
};
