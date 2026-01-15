const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { readDb, writeDb } = require('../lib/db');
const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

const ROLES = { ADMIN:'Admin', MANAGER:'Manager', COMPANY:'Company', INDIVIDUAL:'Individual' };
const SUBSCRIPTION = { TRIAL:'Trial', ACTIVE:'Active', PAST_DUE:'PastDue', LOCKED:'Locked' };

function sanitize(u){ const { passwordHash, ...rest } = u; return rest; }

function ensureAdminFromEnv(){
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if(!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const db = readDb();
  const exists = db.users.find(u=>u.email.toLowerCase()===ADMIN_EMAIL.toLowerCase() && u.role===ROLES.ADMIN);
  if(exists) return;
  const admin = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: ADMIN_EMAIL,
    passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    role: ROLES.ADMIN,
    companyId: null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: SUBSCRIPTION.ACTIVE,
    autoprotechEnabled: true,
    mustResetPassword: false,
    profile: { displayName:'Admin' }
  };
  db.users.push(admin); writeDb(db);
  audit({ actorId: admin.id, action:'ADMIN_BOOTSTRAP', targetType:'User', targetId: admin.id });
}

function createUser({ email, password, role, profile={}, companyId=null }){
  const db = readDb();
  if(db.users.find(u=>u.email.toLowerCase()===email.toLowerCase())) throw new Error('Email already exists');
  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    companyId,
    createdAt: new Date().toISOString(),
    subscriptionStatus: role===ROLES.INDIVIDUAL ? SUBSCRIPTION.TRIAL : SUBSCRIPTION.ACTIVE,
    trialEndsAt: role===ROLES.INDIVIDUAL ? new Date(Date.now()+30*24*3600*1000).toISOString() : null,
    autoprotechEnabled: role===ROLES.ADMIN || role===ROLES.MANAGER,
    mustResetPassword: false,
    profile
  };
  db.users.push(u); writeDb(db);
  audit({ actorId: u.id, action:'USER_CREATED', targetType:'User', targetId: u.id });
  createNotification({ userId: u.id, severity:'info', title:'Welcome', message:'Welcome to AutoShield Tech. Check notifications and start your first project.' });
  return sanitize(u);
}

function findByEmail(email){
  const db = readDb();
  return db.users.find(u=>u.email.toLowerCase()===(email||'').toLowerCase()) || null;
}
function listUsers(){ return readDb().users.map(sanitize); }
function updateUser(id, patch, actorId){
  const db = readDb();
  const u = db.users.find(x=>x.id===id);
  if(!u) throw new Error('User not found');
  Object.assign(u, patch); writeDb(db);
  audit({ actorId, action:'USER_UPDATED', targetType:'User', targetId:id, metadata:patch });
  return sanitize(u);
}
function rotatePlatformIdAndForceReset(id, actorId){
  const db = readDb();
  const u = db.users.find(x=>x.id===id);
  if(!u) throw new Error('User not found');
  u.platformId = `AS-${nanoid(10).toUpperCase()}`;
  u.mustResetPassword = true;
  writeDb(db);
  audit({ actorId, action:'USER_ROTATE_ID', targetType:'User', targetId:id });
  createNotification({ userId:id, severity:'warning', title:'Security reset required', message:'Your platform ID was rotated. Please reset your password before continuing.' });
  return sanitize(u);
}
function setPassword(id, newPassword, actorId){
  const db = readDb();
  const u = db.users.find(x=>x.id===id);
  if(!u) throw new Error('User not found');
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  u.mustResetPassword = false;
  writeDb(db);
  audit({ actorId, action:'USER_PASSWORD_SET', targetType:'User', targetId:id });
  return sanitize(u);
}

module.exports = { ROLES, SUBSCRIPTION, ensureAdminFromEnv, createUser, findByEmail, listUsers, updateUser, rotatePlatformIdAndForceReset, setPassword };
