export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
/** Deposit-linked withdraw cooldown removed — kept at 0 for API backward compatibility (`depositWithdrawLockHours`). */
export const DEPOSIT_WITHDRAW_LOCK_MS = 0;
export const WITHDRAW_DELAY_MS = 96 * ONE_HOUR_MS;
export const WITHDRAW_LIMIT_WINDOW_MS = 30 * ONE_DAY_MS;

export const getMonthStart = (value = new Date()) => new Date(value);

export const ensureMonthWindow = (user, now = new Date()) => {
  const storedMonthStart = user?.monthStart ? new Date(user.monthStart) : null;
  const storedMonthStartMs = storedMonthStart?.getTime();

  if (
    Number.isFinite(storedMonthStartMs) &&
    now.getTime() - storedMonthStartMs < WITHDRAW_LIMIT_WINDOW_MS
  ) {
    return {
      monthStart: storedMonthStart,
      monthlyWithdrawn: Number(user?.monthlyWithdrawn || 0),
      shouldReset: false,
    };
  }

  return {
    monthStart: getMonthStart(now),
    monthlyWithdrawn: 0,
    shouldReset: true,
  };
};
