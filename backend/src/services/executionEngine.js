// ==========================================================
// EXECUTION ENGINE — PAPER TRADING CORE v6
// FIXED: trade persistence + reverse trade recording
// ==========================================================

const outsideBrain =
  require("../../brain/aiBrain");

function clamp(n,min,max){
  return Math.max(min,Math.min(max,n));
}

function safeNum(v,fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureTradeLog(state){
  if(!Array.isArray(state.trades)){
    state.trades = [];
  }
}

/* =========================================================
POSITION SIZE
========================================================= */

function calculatePositionSize(state,price,riskPct){

  const equity =
    safeNum(state.equity,safeNum(state.cashBalance,0));

  if(equity <= 0 || price <= 0)
    return 0;

  const riskCapital = equity * riskPct;

  const qty = riskCapital / price;

  return clamp(qty,0,1000);

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

  ensureTradeLog(state);

  state.position = {
    symbol,
    side,
    entry:price,
    qty,
    time:ts
  };

  const trade = {
    side,
    price,
    qty,
    pnl:0,
    time:ts
  };

  state.trades.push(trade);

  return { result: trade };

}

/* =========================================================
CLOSE POSITION
========================================================= */

function closePosition({
  tenantId,
  state,
  price,
  ts
}){

  ensureTradeLog(state);

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

  state.trades.push(trade);

  state.position = null;

  /* ================= AI LEARNING ================= */

  try{

    outsideBrain.recordTradeOutcome({
      tenantId,
      pnl
    });

  }catch(err){

    console.error("AI learning error:",err.message);

  }

  return { result: trade };

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
  qty,
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

  let positionSize = safeNum(qty,0);

  if(positionSize <= 0){
    positionSize =
      calculatePositionSize(state,price,riskPct);
  }

  if(positionSize <= 0) return null;

  /* ================= BUY ================= */

  if(action === "BUY"){

    if(pos){

      if(pos.side === "LONG"){
        return null;
      }

      if(pos.side === "SHORT"){

        closePosition({
          tenantId,
          state,
          price,
          ts
        });

        return openPosition({
          state,
          symbol,
          price,
          qty:positionSize,
          side:"LONG",
          ts
        });

      }

    }

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"LONG",
      ts
    });

  }

  /* ================= SELL ================= */

  if(action === "SELL"){

    if(pos){

      if(pos.side === "SHORT"){
        return null;
      }

      if(pos.side === "LONG"){

        closePosition({
          tenantId,
          state,
          price,
          ts
        });

        return openPosition({
          state,
          symbol,
          price,
          qty:positionSize,
          side:"SHORT",
          ts
        });

      }

    }

    return openPosition({
      state,
      symbol,
      price,
      qty:positionSize,
      side:"SHORT",
      ts
    });

  }

  /* ================= CLOSE ================= */

  if(action === "CLOSE"){

    if(!pos) return null;

    return closePosition({
      tenantId,
      state,
      price,
      ts
    });

  }

  return null;

}

module.exports = {
  executePaperOrder
};
