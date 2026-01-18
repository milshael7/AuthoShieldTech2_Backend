const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

// ✅ PUBLIC chat endpoint (so Voice + Trading can work even if token isn't attached)
router.post('/chat', async (req, res) => {
  const { message, context } = req.body || {};
  const clean = (message || '').toString().slice(0, 2000);

  res.json({
    ok: true,
    reply: `AutoProtect AI: I received: "${clean}". Paper trader + chart are live. Next step: wire real AI reasoning + risk rules.`,
    contextEcho: context || null,
    ts: new Date().toISOString(),
  });
});

// 🔒 Keep training endpoints protected
router.get('/training/status', authRequired, (req, res) => {
  res.json({ ok: true, status: 'idle', note: 'Worker not connected yet (stub).' });
});

router.post('/training/start', authRequired, (req, res) => {
  res.json({ ok: true, status: 'started', note: 'This is a stub. Connect a worker/queue next.' });
});

router.post('/training/stop', authRequired, (req, res) => {
  res.json({ ok: true, status: 'stopped', note: 'This is a stub. Connect a worker/queue next.' });
});

module.exports = router;
