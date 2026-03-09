// ==========================================================
// AI Config Service — Centralized AI Settings
// Safe for Services + Routes
// ==========================================================

const AI_CONFIG = new Map();

function getAIConfig(tenantId){

  if(!tenantId)
    return defaultConfig();

  if(!AI_CONFIG.has(tenantId)){

    AI_CONFIG.set(tenantId,{
      enabled:true,
      tradingMode:"paper",
      maxTrades:5,
      riskPercent:1.5,
      positionMultiplier:1,
      strategyMode:"Balanced"
    });

  }

  return AI_CONFIG.get(tenantId);
}

function setAIConfig(tenantId,updates={}){

  const current = getAIConfig(tenantId);

  Object.assign(current,updates);

  return current;
}

function defaultConfig(){
  return{
    enabled:true,
    tradingMode:"paper",
    maxTrades:5,
    riskPercent:1.5,
    positionMultiplier:1,
    strategyMode:"Balanced"
  };
}

module.exports = {
  getAIConfig,
  setAIConfig
};
