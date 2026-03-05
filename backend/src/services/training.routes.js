// backend/src/routes/training.routes.js

const express = require("express");
const router = express.Router();

const trainingLab =
  require("../services/trainingLab");

router.get("/run", async (req,res)=>{

  const result =
    await trainingLab.trainAI({
      runs:10
    });

  res.json({
    ok:true,
    result
  });

});

module.exports = router;
