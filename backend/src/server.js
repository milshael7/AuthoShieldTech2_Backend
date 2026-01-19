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

// ✅ Paper trader + Kraken feed
const paperTrader = require('./services/paperTrader');
const { startKrakenFeed } = require('./services/krakenFeed');

function requireEnv(name){
  if(!process.env[name]){
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

ensureDb();
requireEnv('JWT_SECRET');
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

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// --- Rate limit auth endpoints ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATELIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Feature flags (Stage C is locked OFF by default) ---
const LIVE_TRADING_ENABLED = String(process.env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true';

app.get('/health', (req, res) =>
  res.json({ ok: true, name: 'autoshield-tech-backend', time: new Date().toISOString() })
);

// ✅ Quick “are we connected to Kraken?” endpoint
let market = {
  source: 'kraken',
  status: 'booting', // booting | connecting | connected | error | closed
  lastTickTs: 0,
  lastError: null,
};

app.get('/api/market/status', (req, res) => {
  res.json({
    ok: true,
    market,
    liveTrading: {
      enabled: LIVE_TRADING_ENABLED,
      note: LIVE_TRADING_ENABLED
        ? 'Live trading is enabled (still needs broker wiring).'
        : 'Live trading is locked OFF. Paper only.'
    }
  });
});

app.use('/api/auth', authLimiter, require('./routes/auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/manager', require('./routes/manager.routes'));
app.use('/api/company', require('./routes/company.routes'));
app.use('/api/me', require('./routes/me.routes'));
app.use('/api/trading', require('./routes/trading.routes'));
app.use('/api/ai', require('./routes/ai.routes'));

// ✅ Paper status endpoint (frontend reads this)
app.get('/api/paper/status', (req, res) => {
  res.json(paperTrader.snapshot());
});

// --- WebSocket server (frontend connects here) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/market' });

// Last known prices (used for hello snapshot)
let last = { BTCUSDT: 65000, ETHUSDT: 3500 };

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(payload); } catch {}
    }
  });
}

wss.on('connection', (ws) => {
  // Send available symbols + current snapshot
  ws.send(JSON.stringify({ type: 'hello', symbols: Object.keys(last), last, ts: Date.now() }));

  // basic heartbeat (keeps connections stable on some hosts)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// heartbeat interval
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// ✅ Start paper trader (paper always runs)
paperTrader.start();

// ✅ Start Kraken feed and broadcast ticks + feed paper
const feed = startKrakenFeed({
  onStatus: (s) => {
    market.status = s;
    if (s === 'error') market.lastError = market.lastError || 'kraken_error';
    console.log('[kraken]', s);
  },
  onTick: (tick) => {
    // tick: { type:'tick', symbol:'BTCUSDT'|'ETHUSDT', price, ts }
    last[tick.symbol] = tick.price;
    market.lastTickTs = tick.ts || Date.now();

    // feed paper trader with symbol-based ticks
    paperTrader.tick(tick.symbol, tick.price, tick.ts);

    // broadcast to frontend
    broadcast(tick);

    // Stage C placeholder: live trading stays LOCKED OFF
    // (later we will route signals -> broker ONLY if LIVE_TRADING_ENABLED === true)
  }
});

// graceful shutdown
function shutdown() {
  try { clearInterval(heartbeat); } catch {}
  try { feed && feed.stop && feed.stop(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const port = process.env.PORT || 5000;
server.listen(port, () => console.log('AutoShield Tech backend on', port));
