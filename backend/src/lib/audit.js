const { readDb, writeDb } = require('./db');
const { nanoid } = require('nanoid');
function audit(event){
  const db = readDb();
  const rec = { id: nanoid(), at: new Date().toISOString(), ...event };
  db.audit.push(rec);
  writeDb(db);
  return rec;
}
module.exports = { audit };
