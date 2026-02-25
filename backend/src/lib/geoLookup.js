// backend/src/lib/geoLookup.js
// Enterprise Geo Lookup Utility
// Safe External Lookup • Fallback Ready • No Hard Dependency

const https = require("https");

/* =========================================================
   CONFIG
========================================================= */

// You can replace this with your own provider later
const GEO_PROVIDER = "ipapi.co"; // free tier safe
const TIMEOUT_MS = 3000;

/* =========================================================
   INTERNAL REQUEST WRAPPER
========================================================= */

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          reject(new Error("Invalid JSON response"));
        }
      });
    });

    req.on("error", reject);

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Geo lookup timeout"));
    });
  });
}

/* =========================================================
   CLEAN IP
========================================================= */

function extractIp(req) {
  if (!req) return null;

  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return (
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    null
  );
}

/* =========================================================
   GEO LOOKUP
========================================================= */

async function geoLookup(ipOrReq) {
  try {
    const ip =
      typeof ipOrReq === "string"
        ? ipOrReq
        : extractIp(ipOrReq);

    if (!ip) {
      return fallback();
    }

    // Skip local dev IPs
    if (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("192.168.") ||
      ip.startsWith("10.")
    ) {
      return {
        ip,
        country: "Local",
        city: "Localhost",
        region: "Development",
        org: null,
        source: "local"
      };
    }

    const url = `https://${GEO_PROVIDER}/${ip}/json/`;

    const data = await fetchJson(url);

    return {
      ip,
      country: data.country_name || null,
      city: data.city || null,
      region: data.region || null,
      org: data.org || null,
      latitude: data.latitude || null,
      longitude: data.longitude || null,
      source: "remote"
    };

  } catch {
    return fallback();
  }
}

/* =========================================================
   FALLBACK
========================================================= */

function fallback() {
  return {
    ip: null,
    country: null,
    city: null,
    region: null,
    org: null,
    latitude: null,
    longitude: null,
    source: "fallback"
  };
}

module.exports = {
  geoLookup,
  extractIp
};
