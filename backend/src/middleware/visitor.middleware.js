const { trackVisit } = require("../services/visitorTracker");

module.exports = function visitorMiddleware(req, res, next) {
  try {
    trackVisit({
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      country: req.headers["cf-ipcountry"] || "unknown",
      path: req.originalUrl,
    });
  } catch {}

  next();
};
