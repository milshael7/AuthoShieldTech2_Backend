const express = require("express");
const router = express.Router();

const downloader =
  require("../services/dataDownloader");

router.get("/btc", async (req,res)=>{

  const result =
    await downloader.downloadBTC();

  res.json({
    ok:true,
    result
  });

});

module.exports = router;
