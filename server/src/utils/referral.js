import User from "../models/User.js";
import { updateVIP } from "./vip.js";

/**
 * 🔥 Distribute Referral Income (3 Levels)
 * @param {string} userId
 * @param {number} amount
 */
export const distributeReferralIncome = async (userId, amount) => {
  try {
    console.log("Legacy referral income disabled; HybridEarn referral rewards are active");
    return;

    // ✅ VALIDATION
    if (!userId || !amount || amount <= 0) {
      console.log("⚠️ Invalid referral input");
      return;
    }

    // 🔥 LEVEL % (L1, L2, L3)
    const percentages = [10, 5, 3];

    // 🔍 START USER
    let currentUser = await User.findById(userId).select("referredBy");

    if (!currentUser) return;

    for (let level = 0; level < percentages.length; level++) {
      // ❌ stop if no parent
      if (!currentUser.referredBy) break;

      // 🔍 FIND PARENT
      const parent = await User.findById(currentUser.referredBy).select(
        "_id isBlocked"
      );

      if (!parent) break;

      // 🔒 SKIP BLOCKED USER
      if (parent.isBlocked) {
        currentUser = parent;
        continue;
      }

      // 💰 CALCULATE INCOME
      const income = (amount * percentages[level]) / 100;

      if (income <= 0) {
        currentUser = parent;
        continue;
      }

      // 🔥 ATOMIC UPDATE (SAFE)
      await User.updateOne(
        { _id: parent._id },
        {
          $inc: {
            balance: income,
            totalEarnings: income,
            referralEarnings: income,
          },
        }
      );

      // 🔥 VIP UPDATE (AFTER EARNING)
      await updateVIP(parent._id);

      // 🔁 MOVE TO NEXT LEVEL
      currentUser = parent;
    }

    console.log("✅ Referral income distributed (3 levels)");

  } catch (err) {
    console.error("❌ Referral Error:", err.message);
  }
};