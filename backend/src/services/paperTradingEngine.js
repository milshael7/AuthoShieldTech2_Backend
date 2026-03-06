// ==========================================================
// Institutional Paper Trading Engine
// Complete trading ledger for AI trading system
// Deterministic • Crash Safe • Analytics Ready
// ==========================================================

const executionEngine = require("./executionEngine");

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

/* =========================================================
CONFIG
========================================================= */

const CONFIG = Object.freeze({

  startingBalance:
    Number(process.env.PAPER_START_BALANCE || 10000),

  maxTradesStored:
    Number(process.env.PAPER_MAX_TRADE_HISTORY || 500),

  maxEquityHistory:
    Number(process.env.PAPER_MAX_EQUITY_HISTORY || 2000),

});

/* =========================================================
TENANT STATES
========================================================= */

const PAPER_ACCOUNTS = new Map();

/* =========================================================
CREATE ACCOUNT
========================================================= */

function createAccount(tenantId){

  const key = tenantId || "__default__";

  const account = {

    cashBalance:CONFIG.startingBalance,
    equity:CONFIG.startingBalance,
    peakEquity:CONFIG.startingBalance,

    position:null,

    lastPrice:null,

    equityHistory:[],
    trades:[],

    stats:{
      totalTrades:0,
      wins:0,
      losses:0,
      winRate:0,
      avgWin:0,
      avgLoss:0,
      expectancy:0,
      maxDrawdown:0
    },

    realized:{
      net:0,
      grossProfit:0,
      grossLoss:0
    },

    costs:{
      feePaid:0
    },

    limits:{
      tradesToday:0,
      lossesToday:0,
      lastResetDay:new Date().toISOString().slice(0,10)
    }

  };

  PAPER_ACCOUNTS.set(key,account);

  return account;

}

/* =========================================================
GET ACCOUNT
========================================================= */

function getAccount(tenantId){

  const key = tenantId || "__default__";

  if(!PAPER_ACCOUNTS.has(key)){
    return createAccount(key);
  }

  return PAPER_ACCOUNTS.get(key);

}

/* =========================================================
RESET DAILY LIMITS
========================================================= */

function resetDailyLimits(account,ts){

  const day = new Date(ts).toISOString().slice(0,10);

  if(account.limits.lastResetDay !== day){

    account.limits.tradesToday = 0;
    account.limits.lossesToday = 0;
    account.limits.lastResetDay = day;

  }

}

/* =========================================================
UPDATE EQUITY
========================================================= */

function updateEquity(account){

  if(account.position && account.lastPrice){

    const pnl =
      (account.lastPrice - account.position.entry)
      * account.position.qty;

    account.equity =
      account.cashBalance + pnl;

  }
  else{

    account.equity = account.cashBalance;

  }

  account.peakEquity =
    Math.max(account.peakEquity,account.equity);

  const drawdown =
    (account.peakEquity - account.equity) /
    account.peakEquity;

  account.stats.maxDrawdown =
    Math.max(account.stats.maxDrawdown,drawdown);

}

/* =========================================================
EQUITY HISTORY
========================================================= */

function recordEquity(account){

  account.equityHistory.push({
    ts:Date.now(),
    equity:account.equity
  });

  if(account.equityHistory.length > CONFIG.maxEquityHistory){
    account.equityHistory.shift();
  }

}

/* =========================================================
PERFORMANCE STATS
========================================================= */

function updateStats(account,profit){

  account.stats.totalTrades++;

  if(profit > 0){

    account.stats.wins++;
    account.realized.grossProfit += profit;

  }
  else{

    account.stats.losses++;
    account.realized.grossLoss += Math.abs(profit);

  }

  const total = account.stats.totalTrades;

  account.stats.winRate =
    total ? account.stats.wins / total : 0;

  account.stats.avgWin =
    account.stats.wins
      ? account.realized.grossProfit /
        account.stats.wins
      : 0;

  account.stats.avgLoss =
    account.stats.losses
      ? account.realized.grossLoss /
        account.stats.losses
      : 0;

  account.stats.expectancy =
    account.stats.winRate *
      account.stats.avgWin -
    (1-account.stats.winRate) *
      account.stats.avgLoss;

}

/* =========================================================
EXECUTE PAPER TRADE
========================================================= */

function executeTrade({

  tenantId,
  symbol,
  action,
  price,
  riskPct,
  bid,
  ask

}){

  const account = getAccount(tenantId);

  const ts = Date.now();

  resetDailyLimits(account,ts);

  account.lastPrice = price;

  const execution =
    executionEngine.executePaperOrder({
      tenantId,
      symbol,
      action,
      price,
      riskPct,
      bid,
      ask,
      state:account,
      ts
    });

  if(!execution) return null;

  const result = execution.result;

  /* EXIT RESULT */

  if(result.type === "EXIT"){

    const profit = result.pnl;

    updateStats(account,profit);

    account.trades.push({
      time:ts,
      symbol,
      pnl:profit
    });

    if(account.trades.length > CONFIG.maxTradesStored){
      account.trades.shift();
    }

  }

  updateEquity(account);
  recordEquity(account);

  return result;

}

/* =========================================================
ACCOUNT SNAPSHOT (FOR API / UI)
========================================================= */

function getSnapshot(tenantId){

  const account = getAccount(tenantId);

  updateEquity(account);

  return {

    ok:true,

    snapshot:{

      equity:account.equity,
      cashBalance:account.cashBalance,
      position:account.position,

      stats:account.stats,

      realized:account.realized,

      trades:account.trades.slice(-50),

      equityHistory:
        account.equityHistory.map(e=>e.equity),

      limits:account.limits

    }

  };

}

/* =========================================================
RESET ACCOUNT
========================================================= */

function resetAccount(tenantId){

  const key = tenantId || "__default__";

  PAPER_ACCOUNTS.delete(key);

  return createAccount(key);

}

/* ========================================================= */

module.exports={

  executeTrade,
  getSnapshot,
  resetAccount,
  getAccount

};
