const { readDb, writeDb } = require('./db');
const { nanoid } = require('nanoid');

function createNotification({ userId=null, companyId=null, severity='info', title, message }) {
  const db = readDb();
  const n = { id: nanoid(), at: new Date().toISOString(), userId, companyId, severity, title, message, read:false };
  db.notifications.push(n);
  writeDb(db);
  return n;
}
function listNotifications({ userId, companyId }){
  const db = readDb();
  return db.notifications.filter(n=>{
    if (userId && n.userId !== userId) return false;
    if (companyId && n.companyId !== companyId) return false;
    return true;
  }).sort((a,b)=> a.at < b.at ? 1 : -1);
}
function markRead(id){
  const db = readDb();
  const n = db.notifications.find(x=>x.id===id);
  if(!n) return null;
  n.read = true; writeDb(db); return n;
}
module.exports = { createNotification, listNotifications, markRead };
