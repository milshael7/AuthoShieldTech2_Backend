// ============================================================
// AUTOSHIELD OUTSIDE BRAIN INDEX
// Central access point for the platform brain.
// ============================================================

const learningStore = require("./learningStore");
const advisorBrain = require("./advisorBrain");

function getBrainStatus(){

  return {
    learning:"active",
    advisor:"active",
    persistent:true
  };
}

module.exports = {
  learningStore,
  advisorBrain,
  getBrainStatus
};
