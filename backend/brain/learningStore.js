// ============================================================
// AUTOSHIELD OUTSIDE BRAIN — PERSISTENT MEMORY
// This module stores AI learning that survives deploys.
// ============================================================

const { readDb, writeDb } = require("../lib/db");

function getBrain(){

  const db = readDb();

  if(!db.brain){
    db.brain = {
      learning:{},
      advisorMemory:{}
    };
    writeDb(db);
  }

  return db.brain;
}

function getLearning(tenantId){

  const brain = getBrain();

  if(!brain.learning[tenantId]){

    brain.learning[tenantId] = {
      edgeMultiplier:1,
      confidenceMultiplier:1,
      winRate:0.5,
      trades:0,
      updated:Date.now()
    };

    const db = readDb();
    db.brain = brain;
    writeDb(db);
  }

  return brain.learning[tenantId];
}

function saveLearning(tenantId,data){

  const db = readDb();

  if(!db.brain) db.brain = {learning:{}};

  db.brain.learning[tenantId] = {
    ...db.brain.learning[tenantId],
    ...data,
    updated:Date.now()
  };

  writeDb(db);
}

module.exports = {
  getLearning,
  saveLearning
};
