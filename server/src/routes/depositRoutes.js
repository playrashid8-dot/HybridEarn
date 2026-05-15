import express from "express";
import auth from "../middleware/auth.js";

import {
  createDeposit,
  getMyDeposits,
} from "../controllers/depositController.js";

const router = express.Router();

/* ==============================
   📥 CREATE DEPOSIT (USER)
============================== */
router.post("/", auth, createDeposit);

/* ==============================
   📄 MY DEPOSITS (USER)
============================== */
router.get("/my", auth, getMyDeposits);

export default router;