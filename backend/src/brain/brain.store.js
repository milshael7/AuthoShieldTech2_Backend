const fs = require('fs');
const path = require('path');

const BRAIN_PATH = path.join(__dirname, 'brain.memory.json');

function ensureBrain() {
  if (!fs.existsSync(BRAIN_PATH)) {
    fs.writeFileSync(
      BRAIN_PATH,
      JSON.stringify({
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        stats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          totalWinUSD: 0,
          totalLossUSD: 0,
          netPnL: 0,
          maxBalance: 0,
        },
        history: []
      }, null, 2)
    );
  }
}

function readBrain() {
  ensureBrain();
  return JSON.parse(fs.readFileSync(BRAIN_PATH, 'utf-8'));
}

function writeBrain(brain) {
  brain.lastUpdated = Date.now();
  fs.writeFileSync(BRAIN_PATH, JSON.stringify(brain, null, 2));
}

module.exports = {
  ensureBrain,
  readBrain,
  writeBrain,
  BRAIN_PATH,
};
