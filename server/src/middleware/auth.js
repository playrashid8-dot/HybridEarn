import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";

const cookieDebugEnabled =
  process.env.COOKIE_DEBUG === "1" || process.env.NODE_ENV !== "production";

const auth = async (req, res, next) => {
  try {
    if (cookieDebugEnabled) {
      console.log("COOKIES:", req.cookies);
    }

    const token = req.cookies?.token;

    // ❌ EMPTY TOKEN
    if (!token) {
      return res.status(401).json({ success: false, msg: "Token missing", data: null });
    }

    // 🔐 VERIFY TOKEN
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🔍 FETCH USER (LIGHT QUERY)
    if (!mongoose.Types.ObjectId.isValid(decoded.id)) {
      return res.status(401).json({ success: false, msg: "Invalid token", data: null });
    }

    const userId = new mongoose.Types.ObjectId(decoded.id);
    const user = await User.collection.findOne(
      { _id: userId },
      { projection: { _id: 1, email: 1, isBlocked: 1, vipLevel: 1, isAdmin: 1 } }
    );

    if (!user) {
      return res.status(401).json({ success: false, msg: "User not found", data: null });
    }

    // 🔒 BLOCK CHECK
    if (user.isBlocked) {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    // ✅ ATTACH USER (MINIMAL DATA)
    req.user = {
      _id: user._id,
      id: user._id, // legacy compatibility
      vipLevel: user.vipLevel,
      isAdmin: user.isAdmin === true,
    };

    next();

  } catch (err) {
    console.error("AUTH ERROR:", err.message);

    // 🔥 TOKEN EXPIRED
    if (err.name === "TokenExpiredError") {
      console.error("AUTH TOKEN EXPIRED");
      return res.status(401).json({ success: false, msg: "Token expired", data: null });
    }

    // 🔥 INVALID TOKEN
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, msg: "Invalid token", data: null });
    }

    return res.status(401).json({
      success: false,
      msg: "Authorization failed",
      data: null,
    });
  }
};

export default auth;