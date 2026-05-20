import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import {
  TOKEN_COOKIE_NAME,
  logAuthFailure,
  resolveCookieSecure,
  resolveCookieSameSite,
} from "../config/cookieConfig.js";

const cookieDebugEnabled =
  process.env.COOKIE_DEBUG === "1" || process.env.NODE_ENV !== "production";

const auth = async (req, res, next) => {
  try {
    const token = req.cookies?.[TOKEN_COOKIE_NAME];

    if (cookieDebugEnabled) {
      logger.debug("auth cookie debug", {
        path: req.originalUrl,
        cookieNames: Object.keys(req.cookies || {}),
        hasTokenCookie: Boolean(token),
        secure: resolveCookieSecure(),
        sameSite: resolveCookieSameSite(),
      });
    }

    if (!token) {
      logAuthFailure(req, "token missing");
      return res.status(401).json({ success: false, msg: "Token missing", data: null });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!mongoose.Types.ObjectId.isValid(decoded.id)) {
      logAuthFailure(req, "invalid token payload");
      return res.status(401).json({ success: false, msg: "Invalid token", data: null });
    }

    const userId = new mongoose.Types.ObjectId(decoded.id);
    const user = await User.collection.findOne(
      { _id: userId },
      { projection: { _id: 1, email: 1, username: 1, isBlocked: 1, vipLevel: 1, isAdmin: 1 } }
    );

    if (!user) {
      logAuthFailure(req, "user not found", { userId: String(decoded.id) });
      return res.status(401).json({ success: false, msg: "User not found", data: null });
    }

    if (user.isBlocked) {
      logAuthFailure(req, "account blocked", { userId: String(user._id) });
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    req.user = {
      _id: user._id,
      id: user._id,
      username: user.username,
      vipLevel: user.vipLevel,
      isAdmin: user.isAdmin === true || String(user.username || "").toLowerCase() === "admin",
    };

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      logAuthFailure(req, "token expired");
      return res.status(401).json({ success: false, msg: "Token expired", data: null });
    }

    if (err.name === "JsonWebTokenError") {
      logAuthFailure(req, "invalid token", { error: err.message });
      return res.status(401).json({ success: false, msg: "Invalid token", data: null });
    }

    logger.error("auth middleware error", {
      error: err?.message || String(err),
      path: req.originalUrl,
    });

    return res.status(401).json({
      success: false,
      msg: "Authorization failed",
      data: null,
    });
  }
};

export default auth;
