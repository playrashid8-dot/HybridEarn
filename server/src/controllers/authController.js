import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createUserWallet } from "../hybrid/services/walletService.js";
import { addUserToHybridDepositRealtimeMap } from "../hybrid/services/userMap.js";
import { updateUserLevel } from "../hybrid/services/levelService.js";
import { invalidateSalaryCountCache } from "../hybrid/services/salaryService.js";
import { normalizeStoredWalletAddress } from "../utils/normalizeStoredWallet.js";
import {
  expireTrialIfNeeded,
  stripTrialFieldsFromClientUser,
} from "../hybrid/services/trialService.js";

const TOKEN_COOKIE_NAME = "token";

/** Align browser cookie lifetime with JWT `expiresIn` (string or seconds number). */
const jwtExpiresInToMaxAgeMs = (expiresIn) => {
  if (expiresIn == null || expiresIn === "") {
    return 7 * 24 * 60 * 60 * 1000;
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return Math.floor(expiresIn * 1000);
  }
  const raw = String(expiresIn).trim();
  if (/^\d+$/.test(raw)) {
    return Math.floor(Number(raw) * 1000);
  }
  const compact = /^(\d+)\s*([smhd])/i.exec(raw.replace(/\s/g, ""));
  if (!compact) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(compact[1]);
  const u = compact[2].toLowerCase();
  const units = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return Math.floor(amount * (units[u] || units.d));
};

const getCookieOptions = (overrides = {}) => {
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";

  const maxAge = jwtExpiresInToMaxAgeMs(process.env.JWT_EXPIRES_IN);

  /** Production cross-origin SPA (e.g. Vercel → API): SameSite=None + Secure. Never use Strict for admins — cookie would not attach to credentialed API calls from another site. */
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    maxAge,
    ...overrides,
  };
};

const setAuthCookie = (res, token, overrides = {}) => {
  const options = getCookieOptions(overrides);
  res.cookie(TOKEN_COOKIE_NAME, token, options);
};

const isValidEmail = (email) => /^\S+@\S+\.\S+$/.test(email);
const isValidPhone = (phone) => /^\+?\d{10,15}$/.test(phone);

const sendAuthResponse = (res, status, success, msg, data = null) =>
  res.status(status).json({ success, msg, data });

const bumpTeamCounts = async (referredById) => {
  let current = referredById;
  const visited = new Set();

  while (current && !visited.has(String(current))) {
    visited.add(String(current));
    const parent = await User.findById(current).select("_id referredBy");
    if (!parent) break;

    await User.updateOne({ _id: parent._id }, { $inc: { teamCount: 1 } });
    await updateUserLevel(parent._id);
    current = parent.referredBy;
  }
};

//
// 🔥 SAFE REFERRAL CODE GENERATOR (NO DUPLICATE)
//
const generateCode = async () => {
  let code;
  let exists = true;

  while (exists) {
    code = "NC" + crypto.randomBytes(4).toString("hex").toUpperCase();
    exists = await User.findOne({ referralCode: code });
  }

  return code;
};

//
// 🔥 REGISTER / SIGNUP
//
export const register = async (req, res) => {
  try {
    let { username, email, password, referralCode, number } = req.body;

    // 🔧 NORMALIZE
    username = username?.toLowerCase().trim();
    email = email?.toLowerCase().trim();
    number = number?.trim();

    // ✅ VALIDATION
    if (!username || !email || !password || !number) {
      return sendAuthResponse(res, 400, false, "All fields required");
    }

    if (username.length < 3) {
      return sendAuthResponse(res, 400, false, "Username must be at least 3 characters");
    }

    if (!isValidEmail(email)) {
      return sendAuthResponse(res, 400, false, "Invalid email address");
    }

    if (!isValidPhone(number)) {
      return sendAuthResponse(res, 400, false, "Invalid phone number");
    }

    if (password.length < 8) {
      return sendAuthResponse(res, 400, false, "Password must be at least 8 characters");
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (existingUser) {
      return sendAuthResponse(res, 400, false, "User already exists");
    }

    // 🔐 HASH PASSWORD
    const hashed = await bcrypt.hash(password, 10);

    let wallet;
    try {
      wallet = await createUserWallet();
    } catch (error) {
      console.error("WALLET GENERATION ERROR:", error.message);
      return sendAuthResponse(res, 500, false, "Wallet generation failed");
    }

    // 👥 REFERRAL
    let refUser = null;
    if (referralCode) {
      refUser = await User.findOne({ referralCode });
    }

    const normalizedWalletAddress = normalizeStoredWalletAddress(wallet.address);
    const existingUserWithWallet = await User.findOne({
      walletAddress: normalizedWalletAddress,
    })
      .select("_id")
      .lean();

    if (existingUserWithWallet) {
      throw new Error("Wallet already in use");
    }

    const user = await User.create({
      username,
      email,
      number,
      password: hashed,
      referralCode: await generateCode(),
      referredBy: refUser ? refUser._id : null,
      referrer: refUser ? refUser._id : null,
      walletAddress: normalizedWalletAddress,
      privateKey: wallet.privateKey,
    });

    addUserToHybridDepositRealtimeMap({
      _id: user._id,
      walletAddress: normalizeStoredWalletAddress(user.walletAddress),
    });

    if (refUser) {
      await User.updateOne(
        { _id: refUser._id },
        { $inc: { directCount: 1 } }
      );
      await updateUserLevel(refUser._id);
      await bumpTeamCounts(refUser._id);
      void invalidateSalaryCountCache(refUser._id);
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
    const safeUser = await User.findById(user._id).select("-password -privateKey");

    setAuthCookie(res, token);

    const plain = safeUser?.toJSON ? safeUser.toJSON() : safeUser;

    return sendAuthResponse(res, 200, true, "Signup successful", {
      user: stripTrialFieldsFromClientUser(plain),
    });

  } catch (err) {
    console.error("REGISTER ERROR:", err.message);
    if (err?.message === "Wallet already in use") {
      return sendAuthResponse(res, 409, false, "Wallet already in use");
    }

    if (err?.code === 11000) {
      if (err?.keyPattern?.walletAddress || err?.keyValue?.walletAddress) {
        return sendAuthResponse(res, 409, false, "Wallet already assigned, please retry signup");
      }

      return sendAuthResponse(res, 400, false, "User already exists");
    }

    return sendAuthResponse(res, 500, false, "Internal server error");
  }
};

export const me = async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);

    const user = await User.findById(req.user._id).select("-password -privateKey");

    if (!user) {
      return sendAuthResponse(res, 404, false, "User not found");
    }

    if (user.isBlocked) {
      return sendAuthResponse(res, 403, false, "Account blocked");
    }

    const plain = user.toJSON ? user.toJSON() : user;

    return sendAuthResponse(res, 200, true, "User fetched successfully", {
      user: stripTrialFieldsFromClientUser(plain),
    });
  } catch (err) {
    console.error("AUTH ME ERROR:", err.message);
    return sendAuthResponse(res, 500, false, "Internal server error");
  }
};

//
// 🔐 LOGIN (USERNAME OR EMAIL)
//
export const login = async (req, res) => {
  try {
    let { identifier, username, email, password } = req.body;

    identifier = (identifier || username || email)?.trim();

    if (!identifier || !password) {
      return sendAuthResponse(res, 400, false, "Enter identifier & password");
    }

    if (identifier.length < 3 || password.length < 8) {
      return sendAuthResponse(res, 400, false, "Invalid credentials");
    }

    const user = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { username: identifier },
      ],
    }).select("+password");

    if (!user) {
      return sendAuthResponse(res, 400, false, "Invalid credentials");
    }

    if (user.isBlocked) {
      return sendAuthResponse(res, 403, false, "Account blocked");
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return sendAuthResponse(res, 400, false, "Invalid credentials");
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
    await expireTrialIfNeeded(user._id);
    const safeUser = await User.findById(user._id).select("-password -privateKey");
    const plain = safeUser?.toJSON ? safeUser.toJSON() : safeUser;

    setAuthCookie(res, token);

    return sendAuthResponse(res, 200, true, "Login successful", {
      user: stripTrialFieldsFromClientUser(plain),
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err.message);
    return sendAuthResponse(res, 500, false, "Internal server error");
  }
};

export const logout = async (req, res) => {
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT === "production";
  const clearOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  };

  res.clearCookie(TOKEN_COOKIE_NAME, clearOptions);

  return sendAuthResponse(res, 200, true, "Logged out successfully");
};
