import express from "express";
import auth from "../middleware/auth.js";
import Transaction from "../models/Transaction.js";

const router = express.Router();

/* ==============================
   📜 GET USER HISTORY
============================== */
router.get("/", auth, async (req, res) => {
  try {
    const history = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "History fetched",
      data: history,
      history,
    });
  } catch (err) {
    console.error("HISTORY ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

export default router;