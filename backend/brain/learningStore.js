// ============================================================
// AUTOSHIELD OUTSIDE BRAIN — PERSISTENT LEARNING STORE
// Stores strategy learning so the brain survives restarts
// ============================================================

const { readDb, writeDb } = require("../lib/db");

/* ===========================================================
SAFE NUMBER
=========================================================== */

function safeNum(v, fallback = 0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ===========================================================
GET FULL BRAIN
=========================================================== */

function getBrain(){

  const db = readDb();

  if(!db.brain){
    db.brain = {
      learning:{},
      advisorMemory:[]
    };
    writeDb(db);
  }

  return db.brain;
}

/* ===========================================================
GET LEARNING STATE
=========================================================== */

function getLearning(tenantId){

  const brain = getBrain();

  if(!brain.learning[tenantId]){

    brain.learning[tenantId] = {
      edgeMultiplier:1,
      confidenceMultiplier:1,
      winRate:0.5,
      tradeCount:0,
      lastUpdated:Date.now()
    };

    const db = readDb();
    db.brain = brain;
    writeDb(db);
  }

  return brain.learning[tenantId];
}

/* ===========================================================
UPDATE LEARNING
=========================================================== */

function updateLearning(tenantId, updates = {}){

  const db = readDb();

  if(!db.brain){
    db.brain = { learning:{} };
  }

  if(!db.brain.learning[tenantId]){
    db.brain.learning[tenantId] = {
      edgeMultiplier:1,
      confidenceMultiplier:1,
      winRate:0.5,
      tradeCount:0,
      lastUpdated:Date.now()
    };
  }

  const current = db.brain.learning[tenantId];

  db.brain.learning[tenantId] = {
    ...current,
    ...updates,
    tradeCount: safeNum(current.tradeCount) + 1,
    lastUpdated: Date.now()
  };

  writeDb(db);

  return db.brain.learning[tenantId];
}

/* ===========================================================
RESET LEARNING (if needed)
=========================================================== */

function resetLearning(tenantId){

  const db = readDb();

  if(db.brain?.learning?.[tenantId]){
    delete db.brain.learning[tenantId];
    writeDb(db);
  }

}

/* ===========================================================
EXPORT
=========================================================== */

module.exports = {
  getLearning,
  updateLearning,
  resetLearning
};
