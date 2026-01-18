require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { WebSocketServer } = require('ws');

const { ensureDb } = require('./lib/db');
const users = require('./users/user.service');
const paperTrader = require('./services/paperTrader');

// bulletproof env checker
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    console.error('Missing required env var: ' + name);
    process.exit(1);
  }
}

ensureDb();
requireEnv('JWT_SECRET');

// if your user.service needs these, uncomment them:
// requireEnv('ADMIN_EMAIL');
// requireEnv('ADMIN_PASSWORD');

users.ensureAdminFromEnv();

const app = express();

// --- CORS allowlist (set CORS_ORIGINS="https://a.com,https://b.com") ---
const allowlist = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowlist.length === 0) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  credentials: true
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// --- Rate limit auth endpoints ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATELIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) =>
  res.json({ ok: true, name: 'autoshield-tech-backend', time: new Date().toISOString() })
);

app.use('/api/auth', authLimiter, require('./routes/auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/manager', require('./routes/manager.routes'));
app.use('/api/company', require('./routes/company.routes'));
app.use('/api/me', require('./routes/me.routes'));
app.use('/api/trading', require('./routes/trading.routes'));
app.use('/api/ai', require('./routes/ai.routes'));

// ✅ Paper status endpoint (this is what was missing in the live build)
app.get('/api/paper/status', (req, res) => {
  res.json(paperTrader.snapshot());
});

// --- WebSocket market stream (stub; replace with real market data later) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/market' });

function randWalk(v, step = 0.25) {
  const delta = (Math.random() - 0.5) * step;
  return Math.max(0.01, v + delta);
}

let last = { BTCUSDT: 65000, ETHUSDT: 3500 };

// start paper trader safely
try {
  paperTrader.start();
} catch (e) {
  console.error('paperTrader.start failed:', e);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', symbols: Object.keys(last) }));

  const timer = setInterval(() => {
    for (const sym of Object.keys(last)) {
      const step = sym === 'BTCUSDT' ? 50 : 5;
      last[sym] = randWalk(last[sym], step);

      ws.send(JSON.stringify({ type: 'tick', symbol: sym, price: last[sym], ts: Date.now() }));

      // feed paper trader with current tick price
      try {
        paperTrader.tick(last[sym]);
      } catch (e) {
        // don't crash the server if paper trader has an edge-case
        console.error('paperTrader.tick failed:', e.message || e);
      }
    }
  }, 1000);

  ws.on('close', () => clearInterval(timer));
});

const port = process.env.PORT || 5000;
server.listen(port, () => console.log('AutoShield Tech backend on', port));
