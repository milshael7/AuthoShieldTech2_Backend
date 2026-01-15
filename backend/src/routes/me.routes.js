const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');
const { listNotifications, markRead } = require('../lib/notify');
const { createProject } = require('../autoprotect/autoprotect.service');

router.use(authRequired);

router.get('/notifications', (req,res)=>res.json(listNotifications({ userId:req.user.id })));
router.post('/notifications/:id/read', (req,res)=>{
  const n = markRead(req.params.id);
  if(!n) return res.status(404).json({error:'Not found'});
  res.json(n);
});

router.post('/projects', (req,res)=>{
  const { companyId, title, issue } = req.body || {};
  const p = createProject({ actorId:req.user.id, companyId: companyId || req.user.companyId || null, title, issue });
  res.status(201).json(p);
});

module.exports = router;
