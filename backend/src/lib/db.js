const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], companies: [], audit: [], notifications: [] }, null, 2));
  }
}
function readDb(){ ensureDb(); return JSON.parse(fs.readFileSync(DB_PATH,'utf-8')); }
function writeDb(db){ ensureDb(); fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2)); }
module.exports = { DB_PATH, ensureDb, readDb, writeDb };
