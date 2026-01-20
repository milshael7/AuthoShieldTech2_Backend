backend/src/services/paperTrader.js
// Paper trading engine + learning stats + persistence (db.json)
// Goal:
// 1) No reset on page refresh
// 2) Reload state after server restart
// 3) Prevent insane position sizes (respect MAX_USD_PER_TRADE, MAX_TRADES_PER_DAY, cooldown)
// 4) Make P/L math consistent with fees/slippage/spread

const { readDb, writeDb } = require('../lib/db');

// ---------------- Config ----------------
const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);

const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);     // 0.26%
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);    // 8 bp
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);        // 6 bp

// guards
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// persistence key
const DB_KEY = 'paperTrader';

// ---------------- Helpers ----------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
