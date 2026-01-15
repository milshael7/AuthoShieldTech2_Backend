const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

// This is a stub. It returns a safe, deterministic response that you can replace
// with your real AI service later (OpenAI, local model, etc.).
router.use(authRequired);

router.post('/chat', async (req, res) => {
  const { message, context } = req.body || {};
  const clean = (message || '').toString().slice(0, 2000);
  res.json({
    ok: true,
    reply: `AI (stub): I received: "${clean}". Next step is wiring a real AI engine + risk rules.`,
    contextEcho: context || null,
    ts: new Date().toISOString(),
  });
});

router.get('/training/status', (req, res) => {
  res.json({ ok: true, status: 'idle', note: 'Worker not connected yet (stub).' });
});

router.post('/training/start', (req, res) => {
  res.json({ ok: true, status: 'started', note: 'This is a stub. Connect a worker/queue next.' });
});

router.post('/training/stop', (req, res) => {
  res.json({ ok: true, status: 'stopped', note: 'This is a stub. Connect a worker/queue next.' });
});

module.exports = router;
