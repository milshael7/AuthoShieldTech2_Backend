// backend/src/config/tiers.js

const TIERS = {
  STARTER: {
    key: "starter",
    name: "Starter",
    basePrice: 99,
    maxUsers: 5,
    maxEntities: 1,
    userPrice: 12,
    tools: "basic",
  },

  GROWTH: {
    key: "growth",
    name: "Growth",
    basePrice: 249,
    maxUsers: 20,
    maxEntities: 5,
    userPrice: 10,
    tools: "advanced",
  },

  PROFESSIONAL: {
    key: "professional",
    name: "Professional",
    basePrice: 599,
    maxUsers: 50,
    maxEntities: 20,
    userPrice: 8,
    tools: "full",
  },

  ENTERPRISE: {
    key: "enterprise",
    name: "Enterprise",
    basePrice: 0, // custom pricing
    maxUsers: Infinity,
    maxEntities: Infinity,
    userPrice: 0,
    tools: "unlimited",
  },
};

module.exports = TIERS;
