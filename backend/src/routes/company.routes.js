const express = require('express');
const router = express.Router();
const { authRequired, requireRole } = require('../middleware/auth');
const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications, markRead } = require('../lib/notify');

router.use(authRequired);

router.get('/me', (req,res)=>{
  if(!req.user.companyId) return res.status(400).json({error:'No company assigned'});
  res.json(companies.getCompany(req.user.companyId));
});
router.get('/notifications', (req,res)=>{
  if(!req.user.companyId) return res.status(400).json({error:'No company assigned'});
  res.json(listNotifications({ companyId:req.user.companyId }));
});
router.post('/notifications/:id/read', (req,res)=>{
  const n = markRead(req.params.id);
  if(!n) return res.status(404).json({error:'Not found'});
  res.json(n);
});

router.post('/members/add', requireRole(users.ROLES.COMPANY), (req,res)=>{
  try { res.json(companies.addMember(req.user.companyId, req.body.userId, req.user.id)); }
  catch(e){ res.status(400).json({error:e.message}); }
});
router.post('/members/remove', requireRole(users.ROLES.COMPANY), (req,res)=>{
  try { res.json(companies.removeMember(req.user.companyId, req.body.userId, req.user.id)); }
  catch(e){ res.status(400).json({error:e.message}); }
});

module.exports = router;
