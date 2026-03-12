// ============================================================
// AUTOSHIELD ADVISOR BRAIN
// This brain answers platform questions.
// ============================================================

const { readDb, writeDb } = require("../lib/db");

function remember(question,answer){

  const db = readDb();

  if(!db.brain) db.brain = {};
  if(!db.brain.advisorMemory)
    db.brain.advisorMemory = [];

  db.brain.advisorMemory.push({
    question,
    answer,
    ts:Date.now()
  });

  writeDb(db);
}

function recall(){

  const db = readDb();

  return db.brain?.advisorMemory || [];
}

module.exports = {
  remember,
  recall
};
