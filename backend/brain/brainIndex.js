// ============================================================
// AUTOSHIELD OUTSIDE BRAIN INDEX
// Central access point for the platform brain.
// This file connects all brain modules together.
// ============================================================

const aiBrain = require("./aiBrain");
const advisorBrain = require("./advisorBrain");
const learningStore = require("./learningStore");

/* ============================================================
BRAIN STATUS
Used for diagnostics and dashboard telemetry
============================================================ */

function getBrainStatus(){

  return {

    tradingBrain:"active",
    advisorBrain:"active",
    learningStore:"active",

    persistent:true,

    modules:[
      "aiBrain",
      "advisorBrain",
      "learningStore"
    ]

  };

}

/* ============================================================
EXPORT BRAIN SYSTEM
============================================================ */

module.exports = {

  aiBrain,
  advisorBrain,
  learningStore,
  getBrainStatus

};
