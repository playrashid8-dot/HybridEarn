import express from "express";
import auth from "../../middleware/auth.js";
import {
  claimStakeReward,
  createStakePlan,
  getMyStakes,
} from "../controllers/stakingController.js";

const router = express.Router();

router.post("/create", auth, createStakePlan);
router.post("/claim", auth, claimStakeReward);
router.get("/my", auth, getMyStakes);

export default router;
