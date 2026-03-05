const express = require("express");
const router = express.Router();

const replay =
  require("../services/marketReplay");

router.get("/btc", async (req,res)=>{

  const result =
    await replay.replayMarket({
      symbol:"BTCUSDT"
    });

  res.json({
    ok:true,
    result
  });

});

module.exports = router;
