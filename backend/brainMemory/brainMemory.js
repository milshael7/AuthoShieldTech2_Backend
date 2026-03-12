const fs = require("fs");
const path = require("path");

const STORE = path.join(__dirname, "brainStore.json");

/* ================= LOAD MEMORY ================= */

function load() {
  try {
    if (!fs.existsSync(STORE)) {
      fs.writeFileSync(STORE, JSON.stringify({}, null, 2));
      return {};
    }

    const raw = fs.readFileSync(STORE, "utf8");
    return JSON.parse(raw || "{}");

  } catch (err) {
    console.error("Brain memory load error:", err.message);
    return {};
  }
}

/* ================= SAVE MEMORY ================= */

function save(data) {
  try {
    fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Brain memory save error:", err.message);
  }
}

/* ================= UPDATE MEMORY ================= */

function update(updater) {
  try {

    const memory = load();

    const updated =
      typeof updater === "function"
        ? updater(memory) || memory
        : memory;

    save(updated);

    return updated;

  } catch (err) {
    console.error("Brain memory update error:", err.message);
    return {};
  }
}

module.exports = {
  load,
  save,
  update
};
