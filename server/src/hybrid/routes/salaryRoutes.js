import express from "express";
import auth from "../../middleware/auth.js";
import { claimSalaryReward } from "../controllers/salaryController.js";

const router = express.Router();

router.post("/claim", auth, claimSalaryReward);

export default router;
