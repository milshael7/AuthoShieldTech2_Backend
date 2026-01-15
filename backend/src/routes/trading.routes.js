const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

// Simple in-memory candles generator (stub).
// Replace with real broker/exchange data + persistent storage.
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

router.use(authRequired);

router.get('/symbols', (req, res) => {
  res.json({ symbols: ['BTCUSDT', 'ETHUSDT'] });
});

router.get('/candles', (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toString();
  const now = Date.now();
  const start = now - 120 * 60 * 1000;
  const base = symbol === 'ETHUSDT' ? 3500 : 65000;
  const volatility = symbol === 'ETHUSDT' ? 10 : 120;
  res.json({ symbol, interval: '1m', candles: genCandles({ start, base, volatility }) });
});

module.exports = router;
