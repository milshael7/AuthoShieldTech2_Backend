// backend/src/routes/trading.routes.js
const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

/**
 * STAGE C: Safety gate for Live Trading
 * - Public endpoints: GET /symbols, GET /candles, GET /status  (no token needed)
 * - Protected endpoints (token + admin): POST /live/arm, POST /live/disarm
 *
 * NOTE: This file does NOT place real orders. It only controls a safety state.
 */

// -------- In-memory live gate state (resets on server restart) ----------
let LIVE = {
  enabled: (String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true'),
  armedUntil: 0, // epoch ms
};

function now() { return Date.now(); }
function isArmed() { return LIVE.armedUntil && LIVE.armedUntil > now(); }

function isAdmin(req) {
  const role = req?.user?.role || req?.user?.claims?.role;
  return role === 'admin';
}

// ---------- Candles generator (still stub) ----------
function genCandles({ start, count = 120, base = 65000, volatility = 120 }) {
  const candles = [];
  let t = start;
  let price = base;
  for (let i = 0; i < count; i++) {
    const open = price;
    const delta = (Math.random() - 0.5) * volatility;
    const close = Math.max(0.01, open + delta);
    const high = Math.max(open, close) + Math.random() * (volatility * 0.6);
    const low = Math.min(open, close) - Math.random() * (volatility * 0.6);
    candles.push({
      time: Math.floor(t / 1000),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
    price = close;
    t += 60 * 1000;
  }
  return candles;
}

// ---------------- PUBLIC (no token required) ----------------
router.get('/symbols', (req, res) => {
  res.json({ ok: true, symbols: ['BTCUSDT', 'ETHUSDT'] });
});

router.get('/candles', (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toString();
  const nowMs = Date.now();
  const start = nowMs - 120 * 60 * 1000;
  const base = symbol === 'ETHUSDT' ? 3500 : 65000;
  const volatility = symbol === 'ETHUSDT' ? 10 : 120;
  res.json({ ok: true, symbol, interval: '1m', candles: genCandles({ start, base, volatility }) });
});

// This is what your frontend can call to know if Live is allowed (no token needed)
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    modeAllowed: {
      paper: true,
      live: LIVE.enabled && isArmed(),
    },
    live: {
      enabled: LIVE.enabled,
      armed: isArmed(),
      armedUntil: LIVE.armedUntil || 0,
      secondsRemaining: isArmed() ? Math.ceil((LIVE.armedUntil - now()) / 1000) : 0,
    },
    note: 'Live mode is blocked unless LIVE_TRADING_ENABLED=true and live is armed.',
    ts: new Date().toISOString(),
  });
});

// ---------------- PROTECTED (token required) ----------------
router.use(authRequired);

// Admin-only: arm live trading for a short window (default 10 minutes)
router.post('/live/arm', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });

  // Allow enable flip from env only (safer). If env disabled, arming won't help.
  LIVE.enabled = (String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true');

  const minutes = Number(req.body?.minutes || 10);
  const mins = Number.isFinite(minutes) ? Math.max(1, Math.min(60, minutes)) : 10;

  LIVE.armedUntil = Date.now() + mins * 60 * 1000;

  res.json({
    ok: true,
    live: { enabled: LIVE.enabled, armedUntil: LIVE.armedUntil, minutes: mins },
    warning: LIVE.enabled ? null : 'LIVE_TRADING_ENABLED is not true in env, so live is still blocked.',
  });
});

// Admin-only: disarm immediately
router.post('/live/disarm', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_only' });
  LIVE.armedUntil = 0;
  res.json({ ok: true, live: { enabled: LIVE.enabled, armed: false, armedUntil: 0 } });
});

module.exports = router;
