import express from "express";
import auth from "../../middleware/auth.js";
import { claimWithdraw, getMyHybridWithdrawals } from "../controllers/withdrawController.js";

const router = express.Router();

/** Withdraw submission is only POST /api/user/withdraw (avoids duplicate routes). */
router.post("/claim", auth, claimWithdraw);
router.get("/my", auth, getMyHybridWithdrawals);

export default router;
