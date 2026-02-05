// backend/src/routes/trading.routes.js
const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');
const paperTrader = require('../services/paperTrader');

/**
 * TRADING SAFETY GATE + PAPER TRADING API
 *
 * ✅ No real trades placed here
 * ✅ Paper trading is ALWAYS allowed
 * ✅ Live trading requires:
 *    - ENV enable
 *    - Admin arming
 * ✅ Admin + Manager can view paper data
 */

// ------------------ LIVE STATE ------------------
let LIVE = {
  enabled: String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true',
  armedUntil: 0,
};

const now = () => Date.now();
const isArmed = () => LIVE.armedUntil > now();

// ------------------ ROLE CHECK ------------------
function isAdmin(req) {
  return req?.user?.role === 'Admin';
}

function isManagerOrAdmin(req) {
  return req?.user?.role === 'Admin' || req?.user?.role === 'Manager';
}

// ------------------ MOCK CANDLES ------------------
function genCandles({ start, count = 120, base = 65000, volatility = 120 }) {
  let t = start;
  let price = base;

  return Array.from({ length: count }).map(() => {
    const open = price;
    const delta = (Math.random() - 0.5) * volatility;
    const close = Math.max(1, open + delta);
    const high = Math.max(open, close) + Math.random() * volatility * 0.6;
    const low = Math.min(open, close) - Math.random() * volatility * 0.6;
    price = close;

    const candle = {
      time: Math.floor(t / 1000),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    };

    t += 60 * 1000;
    return candle;
  });
}

// ------------------ PUBLIC (NO AUTH) ------------------

// Symbols
router.get('/symbols', (req, res) => {
  res.json({ ok: true, symbols: ['BTCUSDT', 'ETHUSDT'] });
});

// Candles
router.get('/candles', (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT');
  const base = symbol === 'ETHUSDT' ? 3500 : 65000;
  const volatility = symbol === 'ETHUSDT' ? 10 : 120;

  res.json({
    ok: true,
    symbol,
    interval: '1m',
    candles: genCandles({
      start: now() - 120 * 60 * 1000,
      base,
      volatility,
    }),
  });
});

// Trading mode status
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
      armedUntil: LIVE.armedUntil,
      secondsRemaining: isArmed()
        ? Math.ceil((LIVE.armedUntil - now()) / 1000)
        : 0,
    },
    ts: new Date().toISOString(),
  });
});

// ------------------ PROTECTED ------------------
router.use(authRequired);

// ------------------ PAPER TRADER ------------------

/**
 * GET /api/trading/paper/snapshot
 * Admin + Manager
 */
router.get('/paper/snapshot', (req, res) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  res.json({ ok: true, snapshot: paperTrader.snapshot() });
});

/**
 * POST /api/trading/paper/config
 * Admin ONLY
 */
router.post('/paper/config', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  const updated = paperTrader.setConfig(req.body || {});
  res.json({ ok: true, config: updated });
});

/**
 * POST /api/trading/paper/reset
 * Admin ONLY
 */
router.post('/paper/reset', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  paperTrader.hardReset();
  res.json({ ok: true });
});

// ------------------ LIVE ARMING ------------------

/**
 * POST /api/trading/live/arm
 * Admin ONLY
 */
router.post('/live/arm', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  LIVE.enabled = String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true';

  const minutes = Math.max(1, Math.min(Number(req.body?.minutes || 10), 60));
  LIVE.armedUntil = now() + minutes * 60 * 1000;

  res.json({
    ok: true,
    live: {
      enabled: LIVE.enabled,
      armedUntil: LIVE.armedUntil,
      minutes,
    },
  });
});

/**
 * POST /api/trading/live/disarm
 * Admin ONLY
 */
router.post('/live/disarm', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }

  LIVE.armedUntil = 0;

  res.json({
    ok: true,
    live: {
      enabled: LIVE.enabled,
      armed: false,
      armedUntil: 0,
    },
  });
});

module.exports = router;
