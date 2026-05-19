import express from "express";
import auth from "../../middleware/auth.js";
import {
  getHybridDepositDashboard,
  getMyHybridDeposits,
} from "../controllers/depositController.js";

const router = express.Router();

router.get("/summary", auth, getHybridDepositDashboard);
router.get("/my", auth, getMyHybridDeposits);

export default router;
