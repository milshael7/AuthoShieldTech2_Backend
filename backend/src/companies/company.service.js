const { nanoid } = require('nanoid');
const { readDb, writeDb } = require('../lib/db');
const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

function createCompany({ name, country, website, industry, contactEmail, contactPhone, sizeTier='Small', createdBy }){
  const db = readDb();
  const c = { id:nanoid(), name, country, website, industry, contactEmail, contactPhone, sizeTier, createdAt:new Date().toISOString(), status:'Active', createdBy, members:[] };
  db.companies.push(c); writeDb(db);
  audit({ actorId: createdBy, action:'COMPANY_CREATED', targetType:'Company', targetId:c.id });
  createNotification({ companyId:c.id, severity:'info', title:'Company created', message:'Company workspace is ready.' });
  return c;
}
function listCompanies(){ return readDb().companies; }
function getCompany(id){ return readDb().companies.find(c=>c.id===id) || null; }
function addMember(companyId, userId, actorId){
  const db = readDb();
  const c = db.companies.find(x=>x.id===companyId); if(!c) throw new Error('Company not found');
  if(!c.members.includes(userId)) c.members.push(userId);
  writeDb(db); audit({ actorId, action:'COMPANY_ADD_MEMBER', targetType:'Company', targetId:companyId, metadata:{userId} });
  return c;
}
function removeMember(companyId, userId, actorId){
  const db = readDb();
  const c = db.companies.find(x=>x.id===companyId); if(!c) throw new Error('Company not found');
  c.members = c.members.filter(x=>x!==userId);
  writeDb(db); audit({ actorId, action:'COMPANY_REMOVE_MEMBER', targetType:'Company', targetId:companyId, metadata:{userId} });
  return c;
}
module.exports = { createCompany, listCompanies, getCompany, addMember, removeMember };
