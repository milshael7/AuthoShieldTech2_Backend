// backend/src/routes/ai.routes.js
const express = require('express');
const router = express.Router();

// Optional: if you want training endpoints protected, keep authRequired.
// Your current file had authRequired imported but not used for /chat.
// We'll keep /chat PUBLIC, and keep /training/* protected if auth middleware exists.
let authRequired = null;
try {
  ({ authRequired } = require('../middleware/auth'));
} catch {
  authRequired = null;
}

// ---------- helpers ----------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function money(x) {
  const n = num(x);
  const sign = n < 0 ? '-' : '';
  const ax = Math.abs(n);
  if (ax >= 1e12) return `${sign}$${(ax / 1e12).toFixed(2)}t`;
  if (ax >= 1e9)  return `${sign}$${(ax / 1e9).toFixed(2)}b`;
  if (ax >= 1e6)  return `${sign}$${(ax / 1e6).toFixed(2)}m`;
  if (ax >= 1e3)  return `${sign}$${(ax / 1e3).toFixed(2)}k`;
  return `${sign}$${ax.toFixed(2)}`;
}
function pct(x, digits = 2) {
  const n = num(x) * 100;
  return `${n.toFixed(digits)}%`;
}
function pickSymbol(ctx) {
  return (ctx?.paper?.position?.symbol || ctx?.paper?.symbol || ctx?.symbol || 'BTCUSDT').toString();
}

function summarizePaper(ctx) {
  const p = ctx?.paper || {};
  const ls = p.learnStats || {};
  const rz = p.realized || {};
  const costs = p.costs || {};
  const limits = p.limits || {};
  const cfg = p.config || {};

  const balance = num(p.balance);
  const pnl = num(p.pnl ?? rz.net);

  const wins = num(rz.wins);
  const losses = num(rz.losses);
  const grossProfit = num(rz.grossProfit);
  const grossLoss = num(rz.grossLoss);
  const net = num(rz.net ?? pnl);

  const feePaid = num(costs.feePaid);
  const slippage = num(costs.slippageCost);
  const spread = num(costs.spreadCost);

  const ticksSeen = num(ls.ticksSeen);
  const confidence = num(ls.confidence);
  const volatility = num(ls.volatility);
  const trendEdge = num(ls.trendEdge);

  const decision = (ls.decision || 'WAIT').toString();
  const reason = (ls.lastReason || '—').toString();

  const tp = num(cfg.TAKE_PROFIT_PCT ?? cfg.TAKE_PROFIT_PCT ?? cfg.TAKE_PROFIT_PCT);
  const sl = num(cfg.STOP_LOSS_PCT ?? cfg.STOP_LOSS_PCT ?? cfg.STOP_LOSS_PCT);

  return {
    balance, pnl, wins, losses, grossProfit, grossLoss, net,
    feePaid, slippage, spread,
    ticksSeen, confidence, volatility, trendEdge,
    decision, reason,
    limits,
    cfg
  };
}

function liveSummary(ctx) {
  const l = ctx?.live || {};
  return {
    enabled: !!l.enabled,
    dryRun: l.dryRun === undefined ? true : !!l.dryRun,
    armed: !!l.armed,
    keysPresent: l.keysPresent === undefined ? null : !!l.keysPresent
  };
}

function buildAnswer(message, ctx) {
  const cleanMsg = (message || '').toString().trim().slice(0, 2000);
  const sym = pickSymbol(ctx);
  const last = num(ctx?.last ?? ctx?.paper?.lastPriceBySymbol?.[sym] ?? 0);

  const P = summarizePaper(ctx);
  const L = liveSummary(ctx);

  // Key rule/limits extraction (works even if some values are missing)
  const cfg = P.cfg || {};
  const riskPct = num(cfg.RISK_PCT ?? cfg.PAPER_RISK_PCT ?? 0.01);
  const tpPct = num(cfg.TAKE_PROFIT_PCT ?? cfg.PAPER_TP_PCT ?? 0.004);
  const slPct = num(cfg.STOP_LOSS_PCT ?? cfg.PAPER_SL_PCT ?? 0.003);
  const minEdge = num(cfg.MIN_EDGE ?? cfg.PAPER_MIN_TREND_EDGE ?? 0.0007);
  const warmup = num(cfg.WARMUP_TICKS ?? cfg.PAPER_WARMUP_TICKS ?? 250);
  const maxUsd = num(cfg.MAX_USD_PER_TRADE ?? cfg.PAPER_MAX_USD_PER_TRADE ?? 300);
  const maxTrades = num(cfg.MAX_TRADES_PER_DAY ?? cfg.PAPER_MAX_TRADES_PER_DAY ?? 40);
  const cooldownMs = num(cfg.COOLDOWN_MS ?? cfg.PAPER_COOLDOWN_MS ?? 12000);
  const maxDD = num(cfg.MAX_DRAWDOWN_PCT ?? cfg.PAPER_MAX_DRAWDOWN_PCT ?? 0.25);

  const halted = !!P.limits?.halted;
  const haltReason = P.limits?.haltReason || null;

  // Smart-ish explanation rules (deterministic)
  const why = [];
  if (P.ticksSeen < warmup) why.push(`Still in warmup (${P.ticksSeen}/${warmup} ticks).`);
  if (P.confidence < 0.55) why.push(`Confidence low (${pct(P.confidence, 0)}).`);
  if (Math.abs(P.trendEdge) < minEdge) why.push(`Trend edge below threshold (${P.trendEdge.toExponential(2)} < ${minEdge}).`);
  if (halted) why.push(`HALTED: ${haltReason || 'risk stop triggered'}.`);

  const edgeDir = P.trendEdge > 0 ? 'uptrend' : (P.trendEdge < 0 ? 'downtrend' : 'flat');
  const decisionLine =
    `Decision: ${P.decision} • Reason: ${P.reason} • Edge: ${edgeDir} (${P.trendEdge.toExponential(2)}) • Conf: ${pct(P.confidence, 0)} • Vol: ${pct(P.volatility, 2)}`;

  const scoreboard =
    `Scoreboard: Wins ${P.wins} | Losses ${P.losses} | Total Gain ${money(P.grossProfit)} | Total Loss ${money(P.grossLoss)} | Net ${money(P.net)}`;

  const accounting =
    `Balance: ${money(P.balance)} • Net P&L: ${money(P.pnl)} • Costs: fees ${money(P.feePaid)}, slippage ${money(P.slippage)}, spread ${money(P.spread)}`;

  const rules =
    `Risk rules: TP ${pct(tpPct, 2)} • SL ${pct(slPct, 2)} • MinEdge ${minEdge} • Warmup ${warmup} ticks • RiskPct ${pct(riskPct, 2)} • MaxUSD/Trade ${money(maxUsd)} • Cooldown ${(cooldownMs/1000).toFixed(1)}s • MaxTrades/Day ${maxTrades} • MaxDrawdown ${pct(maxDD, 0)}`;

  const live =
    `Live mode: enabled=${String(L.enabled)} • dryRun=${String(L.dryRun)} • armed=${String(L.armed)}${L.keysPresent === null ? '' : ` • keysPresent=${String(L.keysPresent)}`}`;

  // If user asks “why did you enter” but decision isn't BUY, answer honestly
  const q = cleanMsg.toLowerCase();
  let direct = '';
  if (q.includes('why') && (q.includes('enter') || q.includes('buy'))) {
    if (P.decision !== 'BUY') {
      direct =
        `You asked why I entered — I did NOT enter right now. Current decision is ${P.decision} because: ${P.reason}.`;
    } else {
      direct =
        `I entered because confidence was high (${pct(P.confidence,0)}), edge exceeded MIN_EDGE (${P.trendEdge.toExponential(2)}), warmup passed, and limits/cooldown allowed the trade.`;
    }
  } else if (q.includes('win') || q.includes('loss') || q.includes('p&l') || q.includes('pnl')) {
    direct = scoreboard;
  } else if (q.includes('fees') || q.includes('slippage') || q.includes('spread')) {
    direct = accounting;
  } else if (q.includes('live') || q.includes('real money') || q.includes('kraken')) {
    direct = live + `\n` + `IMPORTANT: I will not place real orders unless Live is enabled AND dryRun is OFF (and order routing is implemented).`;
  } else if (!cleanMsg) {
    direct = `Ask me: "why did you buy?", "how many wins?", "what are the risk rules?", or "are we live-ready?"`;
  } else {
    direct = `Got you. Here’s what I see right now:`;
  }

  const extraWhy = why.length ? `Blockers:\n- ${why.join('\n- ')}` : '';

  const lines = [
    `AutoProtect (Trading Brain)`,
    `Symbol: ${sym}${last ? ` • Last: $${last.toFixed(2)}` : ''}`,
    '',
    direct,
    '',
    decisionLine,
    scoreboard,
    accounting,
    rules,
    live,
    extraWhy ? `\n${extraWhy}` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

// ✅ PUBLIC chat endpoint
router.post('/chat', async (req, res) => {
  const { message, context } = req.body || {};
  const reply = buildAnswer(message, context);
  res.json({ ok: true, reply, ts: new Date().toISOString() });
});

// 🔒 Keep training endpoints protected (if middleware exists)
if (authRequired) {
  router.get('/training/status', authRequired, (req, res) => {
    res.json({ ok: true, status: 'idle', note: 'Worker not connected yet (stub).' });
  });

  router.post('/training/start', authRequired, (req, res) => {
    res.json({ ok: true, status: 'started', note: 'This is a stub. Connect a worker/queue next.' });
  });

  router.post('/training/stop', authRequired, (req, res) => {
    res.json({ ok: true, status: 'stopped', note: 'This is a stub. Connect a worker/queue next.' });
  });
}

module.exports = router;
