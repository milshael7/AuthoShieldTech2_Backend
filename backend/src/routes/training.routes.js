const express = require("express");
const router = express.Router();

/*
AI Training Lab
Used to trigger strategy discovery or reinforcement training
*/

router.get("/status", (req, res) => {
  res.json({
    ok: true,
    message: "Training lab online"
  });
});

router.post("/start", (req, res) => {
  res.json({
    ok: true,
    message: "Training started"
  });
});

module.exports = router;
