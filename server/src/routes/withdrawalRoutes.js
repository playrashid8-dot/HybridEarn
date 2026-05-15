import express from "express";
import auth from "../middleware/auth.js";

import {
  createWithdrawal,
  getMyWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
} from "../controllers/withdrawalController.js";

const router = express.Router();

/* ==============================
   🔐 ADMIN CHECK
============================== */
const isAdmin = async (req, res, next) => {
  try {
    if (!req.user?._id || req.user.isAdmin !== true) {
      return res.status(403).json({
        success: false,
        msg: "Admin access only",
        data: null,
      });
    }

    next();
  } catch (err) {
    console.error("WITHDRAWAL ADMIN CHECK ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};

/* ==============================
   👤 USER ROUTES
============================== */
router.post("/", auth, createWithdrawal);
router.get("/my", auth, getMyWithdrawals);

/* ==============================
   👑 ADMIN ROUTES
============================== */
router.post("/approve/:id", auth, isAdmin, approveWithdrawal);
router.post("/reject/:id", auth, isAdmin, rejectWithdrawal);

export default router;