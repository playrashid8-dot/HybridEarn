import express from "express";
import auth from "../middleware/auth.js";
import Investment from "../models/Investment.js";

import {
  createInvestment,
  getMyInvestments,
} from "../controllers/investmentController.js";

const router = express.Router();

/* ==============================
   💰 CREATE INVESTMENT
============================== */
router.post("/", auth, createInvestment);

/* ==============================
   📄 ALL MY INVESTMENTS
============================== */
router.get("/my", auth, getMyInvestments);

/* ==============================
   🔥 ACTIVE INVESTMENTS
============================== */
router.get("/active", auth, async (req, res) => {
  try {
    const investments = await Investment.find({
      userId: req.user._id,
      status: "active",
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "Active investments fetched successfully",
      data: { investments },
    });

  } catch (err) {
    console.error("ACTIVE INVESTMENTS ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

/* ==============================
   ✅ COMPLETED INVESTMENTS
============================== */
router.get("/completed", auth, async (req, res) => {
  try {
    const investments = await Investment.find({
      userId: req.user._id,
      status: "completed",
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "Completed investments fetched successfully",
      data: { investments },
    });

  } catch (err) {
    console.error("COMPLETED INVESTMENTS ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

/* ==============================
   📊 INVESTMENT SUMMARY
============================== */
router.get("/summary", auth, async (req, res) => {
  try {
    const investments = await Investment.find({
      userId: req.user._id,
    });

    let totalInvested = 0;
    let totalEarned = 0;
    let activeCount = 0;

    investments.forEach((inv) => {
      totalInvested += inv.amount;
      totalEarned += inv.totalEarned || 0;

      if (inv.status === "active") {
        activeCount++;
      }
    });

    res.json({
      success: true,
      msg: "Investment summary fetched successfully",
      data: {
        summary: {
          totalInvested,
          totalEarned,
          activeCount,
        },
      },
    });

  } catch (err) {
    console.error("SUMMARY ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

export default router;