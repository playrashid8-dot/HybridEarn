import express from "express";
import auth from "../../middleware/auth.js";
import { claimRoi, getRoiClaimStatus } from "../controllers/roiController.js";

const router = express.Router();

router.get("/claim-status", auth, getRoiClaimStatus);
router.post("/claim", auth, claimRoi);

export default router;
