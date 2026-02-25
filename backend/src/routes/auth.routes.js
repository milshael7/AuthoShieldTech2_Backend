// backend/src/routes/auth.routes.js
// Auth API — Enterprise Hardened • Tools Engine Integrated

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

const { sign } = require("../lib/jwt");
const { authRequired } = require("../middleware/auth");
const { readDb } = require("../lib/db");
const users = require("../users/user.service");

const {
  canAccessTool,
  seedToolsIfEmpty
} = require("../lib/tools.engine");

/* =========================================================
   HELPERS
========================================================= */

function cleanEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function resolveAccountType(user) {
  if (user.role === users.ROLES.ADMIN) return "ADMIN";
  if (user.role === users.ROLES.MANAGER) return "MANAGER";
  if (
    user.role === users.ROLES.COMPANY ||
    user.role === users.ROLES.SMALL_COMPANY
  ) return "COMPANY";
  return "INDIVIDUAL";
}

function resolveAutodev(user) {
  const db = readDb();
  seedToolsIfEmpty(db);

  const tool = (db.tools || []).find(t => t.id === "autodev-65");

  const allowed = canAccessTool(
    user,
    tool,
    users.ROLES,
    users.SUBSCRIPTION
  );

  let limit = 0;

  if (user.role === users.ROLES.ADMIN ||
      user.role === users.ROLES.MANAGER) {
    limit = "unlimited";
  } else if (
    user.role === users.ROLES.INDIVIDUAL &&
    user.subscriptionStatus === users.SUBSCRIPTION.ACTIVE
  ) {
    limit = 10;
  }

  return {
    allowed,
    limit
  };
}

function safeUserResponse(u) {
  const autodev = resolveAutodev(u);

  return {
    id: u.id,
    role: u.role,
    email: u.email,
    companyId: u.companyId || null,
    subscriptionStatus: u.subscriptionStatus,
    status: u.status,
    mustResetPassword: !!u.mustResetPassword,

    accountType: resolveAccountType(u),

    freedomEnabled: !!u.freedomEnabled,
    autoprotectEnabled: !!u.autoprotectEnabled,

    autodev
  };
}

function ensureJwtSecret(res) {
  if (!process.env.JWT_SECRET) {
    res.status(500).json({
      error: "Server misconfigured (JWT_SECRET missing)"
    });
    return false;
  }
  return true;
}

function ensureCompanyValid(user) {
  if (!user.companyId) return;

  const db = readDb();
  const company = (db.companies || []).find(
    c => c.id === user.companyId
  );

  if (!company) throw new Error("Company not found");
  if (company.status !== "Active") throw new Error("Company not active");

  const member = (company.members || []).find(
    m => String(m.userId || m) === String(user.id)
  );

  if (!member) throw new Error("User not assigned to company");
}

function ensureSubscription(user) {
  const status = String(user.subscriptionStatus || "");

  if (status === users.SUBSCRIPTION.LOCKED)
    throw new Error("Subscription locked");

  if (status === users.SUBSCRIPTION.PAST_DUE)
    throw new Error("Subscription past due");
}

/* =========================================================
   SIGNUP
========================================================= */

router.post("/signup", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);
    const role = cleanStr(req.body?.role || users.ROLES.INDIVIDUAL);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required"
      });
    }

    const created = await users.createUser({
      email,
      password,
      role
    });

    return res.status(201).json({
      ok: true,
      message: "Account created. Pending approval.",
      user: safeUserResponse(created)
    });

  } catch (e) {
    return res.status(400).json({
      error: e?.message || String(e)
    });
  }
});

/* =========================================================
   LOGIN
========================================================= */

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required"
      });
    }

    const u = users.findByEmail(email);

    if (!u) {
      await bcrypt.compare(password, "$2a$10$invalidsaltinvalidsaltinv");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, u.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (u.status !== users.APPROVAL_STATUS.APPROVED) {
      return res.status(403).json({
        error: "Account not approved",
        status: u.status
      });
    }

    if (u.locked === true) {
      return res.status(403).json({
        error: "Account suspended"
      });
    }

    ensureCompanyValid(u);
    ensureSubscription(u);

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      {
        id: u.id,
        role: u.role,
        companyId: u.companyId || null
      },
      null,
      "7d"
    );

    return res.json({
      token,
      user: safeUserResponse(u)
    });

  } catch (e) {
    return res.status(403).json({
      error: e?.message || String(e)
    });
  }
});

/* =========================================================
   REFRESH
========================================================= */

router.post("/refresh", authRequired, (req, res) => {
  try {
    const dbUser = users.findById(req.user.id);
    if (!dbUser) {
      return res.status(401).json({ error: "User not found" });
    }

    if (dbUser.status !== users.APPROVAL_STATUS.APPROVED) {
      return res.status(403).json({ error: "Account not approved" });
    }

    if (dbUser.locked === true) {
      return res.status(403).json({ error: "Account suspended" });
    }

    ensureCompanyValid(dbUser);
    ensureSubscription(dbUser);

    if (!ensureJwtSecret(res)) return;

    const token = sign(
      {
        id: dbUser.id,
        role: dbUser.role,
        companyId: dbUser.companyId || null
      },
      null,
      "7d"
    );

    return res.json({
      token,
      user: safeUserResponse(dbUser)
    });

  } catch (e) {
    return res.status(403).json({
      error: e?.message || String(e)
    });
  }
});

module.exports = router;
