// backend/src/lib/autodev.js
// Autodev 6.5 Enforcement Engine
// Controls who can enable auto protection
// Controls company protection limits

function canUseAutoProtect(user) {
  if (!user) return false;

  // Admin & Manager always allowed
  if (user.accountType === "admin") return true;
  if (user.accountType === "manager") return true;

  // Single user must have freedom enabled
  if (user.accountType === "single" && user.freedomEnabled) {
    return true;
  }

  // Seat must upgrade (freedom enabled)
  if (user.accountType === "seat" && user.freedomEnabled) {
    return true;
  }

  // Company accounts never allowed
  return false;
}

function autoProtectLimit(user) {
  if (!user) return 0;

  // Unlimited
  if (user.accountType === "admin") return Infinity;
  if (user.accountType === "manager") return Infinity;

  // Upgraded Single / Seat = 10 max
  if (
    (user.accountType === "single" ||
      user.accountType === "seat") &&
    user.freedomEnabled
  ) {
    return 10;
  }

  return 0;
}

function enforceLimit(user) {
  const limit = autoProtectLimit(user);

  if (limit === Infinity) return { ok: true };

  const current = user.managedCompanies?.length || 0;

  if (current > limit) {
    return {
      ok: false,
      error: `Autodev 6.5 limit exceeded. Maximum ${limit} companies allowed.`,
    };
  }

  return { ok: true };
}

module.exports = {
  canUseAutoProtect,
  autoProtectLimit,
  enforceLimit,
};
