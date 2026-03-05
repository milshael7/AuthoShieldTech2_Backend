// backend/src/services/strategyLab.js
// Phase 1 Strategy Evolution Engine
// Generates and evaluates multiple strategies

const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

const LAB = new Map();

const MAX_STRATEGIES = 20;
const MIN_TRADES_FOR_EVAL = 15;

/* =====================================================
STATE
===================================================== */

function getState(tenantId){

  const key = tenantId || "__default__";

  if(!LAB.has(key)){

    LAB.set(key,{
      strategies:{},
      activeStrategies:[]
    });

    seedStrategies(key);
  }

  return LAB.get(key);
}

/* =====================================================
SEED INITIAL STRATEGIES
===================================================== */

function seedStrategies(tenantId){

  const state = LAB.get(tenantId);

  for(let i=0;i<10;i++){

    const id = `S${i}_${Date.now()}`;

    state.strategies[id]={
      id,
      edgeThreshold:0.0005 + Math.random()*0.002,
      confidenceThreshold:0.55 + Math.random()*0.2,
      riskMultiplier:0.7 + Math.random()*1.1,

      trades:0,
      wins:0,
      losses:0,
      pnl:0
    };

    state.activeStrategies.push(id);

  }

}

/* =====================================================
GET ACTIVE STRATEGY
===================================================== */

function selectStrategy(tenantId){

  const state = getState(tenantId);

  const ids = state.activeStrategies;

  if(!ids.length)
    return null;

  const id = ids[Math.floor(Math.random()*ids.length)];

  return state.strategies[id];

}

/* =====================================================
RECORD TRADE
===================================================== */

function recordTrade({
  tenantId,
  strategyId,
  profit
}){

  const state = getState(tenantId);

  const s = state.strategies[strategyId];

  if(!s) return;

  s.trades++;

  if(profit>0)
    s.wins++;
  else
    s.losses++;

  s.pnl += profit;

  if(s.trades >= MIN_TRADES_FOR_EVAL)
    evaluateStrategies(tenantId);

}

/* =====================================================
EVALUATION
===================================================== */

function evaluateStrategies(tenantId){

  const state = getState(tenantId);

  const list = Object.values(state.strategies);

  list.sort((a,b)=>b.pnl-a.pnl);

  state.activeStrategies =
    list.slice(0,10).map(s=>s.id);

  if(list.length < MAX_STRATEGIES)
    mutateStrategy(tenantId,list[0]);

}

/* =====================================================
MUTATION
===================================================== */

function mutateStrategy(tenantId,parent){

  const state = getState(tenantId);

  const id = `S${Date.now()}_${Math.random()}`;

  const child = {

    id,

    edgeThreshold:
      clamp(parent.edgeThreshold*(0.9+Math.random()*0.2),
      0.0003,
      0.003),

    confidenceThreshold:
      clamp(parent.confidenceThreshold*(0.9+Math.random()*0.2),
      0.5,
      0.85),

    riskMultiplier:
      clamp(parent.riskMultiplier*(0.9+Math.random()*0.2),
      0.5,
      2),

    trades:0,
    wins:0,
    losses:0,
    pnl:0
  };

  state.strategies[id]=child;
  state.activeStrategies.push(id);

}

module.exports={
  selectStrategy,
  recordTrade
};
