import User from "../../models/User.js";
import { LEVEL_RULES } from "../utils/constants.js";
import { addHybridLedgerEntries } from "./ledgerService.js";

const getEligibleLevel = (user) => {
  let level = 0;

  for (const rule of LEVEL_RULES) {
    const depositOk =
      Number(user.depositBalance || 0) >= rule.minDeposit;
    const directOk =
      Number(user.directCount || 0) >= rule.directCount;
    const teamOk = Number(user.teamCount || 0) >= rule.teamCount;

    if (depositOk && directOk && teamOk) {
      level = rule.level;
    }
  }

  return Math.max(level, Number(user.level || 0), Number(user.vipLevel || 0));
};

export const syncUserLevel = async (userId, session = null) => {
  const userQuery = User.findById(userId).select(
    "depositBalance directCount teamCount level vipLevel levelBonusStage rewardBalance totalEarnings"
  );
  if (session) userQuery.session(session);
  const user = await userQuery;

  if (!user) {
    return null;
  }

  const nextLevel = getEligibleLevel(user);
  const currentBonusStage = Number(user.levelBonusStage || 0);
  const pendingBonuses = LEVEL_RULES.filter(
    (rule) => rule.level <= nextLevel && rule.level > currentBonusStage
  );
  const bonusTotal = pendingBonuses.reduce((sum, rule) => sum + rule.bonus, 0);

  const update = {
    $set: {
      level: nextLevel,
      vipLevel: nextLevel,
      levelBonusStage: Math.max(currentBonusStage, nextLevel),
    },
  };

  if (bonusTotal > 0) {
    update.$inc = {
      rewardBalance: bonusTotal,
      totalEarnings: bonusTotal,
    };
  }

  const updatedUser = await User.findOneAndUpdate(
    {
      _id: userId,
      levelBonusStage: currentBonusStage,
    },
    update,
    {
      returnDocument: "after",
      ...(session ? { session } : {}),
    }
  );

  if (!updatedUser) {
    const fallbackQuery = User.findById(userId);
    if (session) fallbackQuery.session(session);
    return fallbackQuery;
  }

  if (bonusTotal > 0) {
    await addHybridLedgerEntries(
      pendingBonuses.map((rule) => ({
        userId,
        entryType: "credit",
        balanceType: "rewardBalance",
        amount: rule.bonus,
        source: "level_bonus",
        meta: {
          level: rule.level,
        },
      })),
      session
    );
  }

  return updatedUser;
};

export const updateUserLevel = syncUserLevel;
