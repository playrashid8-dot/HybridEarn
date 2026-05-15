/** Withdrawable / stakeable: deposit + reward only (promotional trial principal excluded). */
export const getSpendableHybridBalance = (user) =>
  Number(user?.depositBalance || 0) + Number(user?.rewardBalance || 0);

export const splitHybridBalance = (user, amount) => {
  const targetAmount = Number(amount || 0);
  const rewardBalance = Number(user?.rewardBalance || 0);
  const depositBalance = Number(user?.depositBalance || 0);

  if (targetAmount <= 0) {
    return {
      rewardBalance: 0,
      depositBalance: 0,
    };
  }

  const rewardPart = Math.min(rewardBalance, targetAmount);
  const depositPart = Number((targetAmount - rewardPart).toFixed(8));

  if (rewardPart + depositPart > rewardBalance + depositBalance + 0.0000001) {
    throw new Error("Insufficient Hybrid balance");
  }

  return {
    rewardBalance: Number(rewardPart.toFixed(8)),
    depositBalance: Number(depositPart.toFixed(8)),
  };
};
