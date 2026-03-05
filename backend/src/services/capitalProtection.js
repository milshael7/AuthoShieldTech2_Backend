// ==========================================================
// Capital Protection Layer
// Prevents oversized trades and capital loss
// ==========================================================

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const CONFIG = Object.freeze({

  maxRiskPerTrade: Number(process.env.MAX_RISK_PER_TRADE || 0.02), // 2%
  minTradeUsd: Number(process.env.MIN_TRADE_USD || 50),
  maxTradeUsd: Number(process.env.MAX_TRADE_USD || 100000),

});

/* =========================================================
CALCULATE SAFE ORDER SIZE
========================================================= */

function computeSafeTradeSize({

  balanceUsd,
  requestedRiskPct,
  price

}) {

  if (!balanceUsd || !price) return null;

  const maxAllowedRisk =
    balanceUsd * CONFIG.maxRiskPerTrade;

  const requestedUsd =
    balanceUsd * (requestedRiskPct || CONFIG.maxRiskPerTrade);

  const safeUsd =
    clamp(
      requestedUsd,
      CONFIG.minTradeUsd,
      maxAllowedRisk
    );

  if (safeUsd < CONFIG.minTradeUsd) {
    return null;
  }

  const qty = safeUsd / price;

  return {
    usd: safeUsd,
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

}) {

  const result =
    computeSafeTradeSize({
      balanceUsd,
      requestedRiskPct: riskPct,
      price
    });

  if (!result) {

    return {
      allow: false,
      reason: "Trade below minimum size"
    };

  }

  return {
    allow: true,
    usd: result.usd,
    qty: result.qty
  };

}

module.exports = {
  validateOrder
};
