import Investment from "../models/Investment.js";
import User from "../models/User.js";
import Transaction from "../models/Transaction.js";
import { distributeReferralIncome } from "../utils/referral.js";

//
// 🔥 CREATE INVESTMENT
//
export const createInvestment = async (req, res) => {
  try {
    return res.status(400).json({
      success: false,
      msg: "Legacy investments are disabled. HybridEarn is the active earning system.",
      data: null,
    });

    let { amount, plan } = req.body;

    amount = Number(amount);

    // ✅ VALIDATION
    if (!amount || amount < 10) {
      return res.status(400).json({
        success: false,
        msg: "Minimum investment is $10",
        data: null,
      });
    }

    const plans = {
      basic: { roi: 1, days: 30 },
      silver: { roi: 1.5, days: 45 },
      gold: { roi: 2, days: 60 },
      vip: { roi: 2.5, days: 90 },
    };

    if (!plans[plan]) {
      return res.status(400).json({
        success: false,
        msg: "Invalid plan",
        data: null,
      });
    }

    // 🔍 USER
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found",
        data: null,
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        msg: "Account blocked",
        data: null,
      });
    }

    if (user.balance < amount) {
      return res.status(400).json({
        success: false,
        msg: "Insufficient balance",
        data: null,
      });
    }

    const selected = plans[plan];

    const endDate = new Date(
      Date.now() + selected.days * 24 * 60 * 60 * 1000
    );

    // 🔥 ATOMIC BALANCE UPDATE
    await User.updateOne(
      { _id: user._id, balance: { $gte: amount } },
      {
        $inc: {
          balance: -amount,
          totalInvested: amount,
        },
      }
    );

    // 🔥 CREATE INVESTMENT
    const investment = await Investment.create({
      userId: user._id,
      amount,
      dailyROI: selected.roi,
      duration: selected.days,
      endDate,
      status: "active",
    });

    // 🔥 CREATE TRANSACTION (HISTORY)
    await Transaction.create({
      user: user._id,
      type: "investment",
      amount,
      status: "active",
      refId: investment._id, // 🔥 best practice
    });

    // 🔥 REFERRAL
    await distributeReferralIncome(user._id, amount);

    res.json({
      success: true,
      msg: "Investment started 🚀",
      data: { investment },
    });

  } catch (err) {
    console.error("INVESTMENT ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};


//
// 📄 USER INVESTMENTS
//
export const getMyInvestments = async (req, res) => {
  try {
    const data = await Investment.find({ userId: req.user._id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "Investments fetched successfully",
      data: { investments: data },
    });

  } catch (err) {
    console.error("GET INVESTMENTS ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};