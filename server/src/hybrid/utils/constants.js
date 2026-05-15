export const HYBRID_BASE_PATH = "m/44'/60'/0'/0";

export const HYBRID_TOKEN = {
  symbol: "USDT",
  network: "BEP20",
  decimals: Number(process.env.HYBRID_USDT_DECIMALS || 18),
};

/** Hybrid Earn daily ROI by VIP level (decimal rate per day). */
export const ROI_RATES = {
  0: 0,
  1: 0.04,
  2: 0.045,
  3: 0.05,
};

export const LEVEL_RULES = [
  {
    level: 1,
    minDeposit: 50,
    directCount: 0,
    teamCount: 0,
    bonus: 5,
  },
  {
    level: 2,
    minDeposit: 500,
    directCount: 5,
    teamCount: 15,
    bonus: 20,
  },
  {
    level: 3,
    minDeposit: 2000,
    directCount: 18,
    teamCount: 45,
    bonus: 50,
  },
];

/**
 * Salary milestone counts only include “active” investors at or above this USDT deposit
 * (must stay aligned with salaryService / deposit listeners).
 */
export const SALARY_ACTIVE_INVESTOR_MIN_USDT = 50;

/** BFS chunk size for `$in` batches (bound per query, avoids huge single reads). */
export const SALARY_BFS_FRONTIER_CHUNK = 5000;

/**
 * Max BFS waves (depth layers). Single source of truth — avoids “iterations vs waves” mismatch
 * that previously capped traversal at 100 levels while claiming 4096-capable.
 */
export const SALARY_BFS_MAX_WAVES = 4096;

/** Safety cap: stop counting after this many fresh qualifying nodes (memory / stability). */
export const SALARY_BFS_MAX_QUALIFYING_NODES = 10000;

/** Yield to the event loop every N waves when the frontier is large (large-network fairness). */
export const SALARY_BFS_YIELD_EVERY_WAVES = 32;
export const SALARY_BFS_YIELD_MIN_FRONTIER = 2000;

/** Redis cache TTL for GET salary counts (never used inside claim transactions). */
export const SALARY_COUNT_CACHE_TTL_SEC = 30;

/** Bump when count semantics change to invalidate old Redis payloads. */
export const SALARY_COUNT_CACHE_KEY_PREFIX = "salary_count:v2:";

/** Stage thresholds: each stage uses fresh counts since lastClaimedAt only (see salaryService). */
export const SALARY_RULES = [
  { stage: 2, directCount: 10, teamCount: 35, amount: 80 },
  { stage: 3, directCount: 25, teamCount: 100, amount: 250 },
  { stage: 4, directCount: 45, teamCount: 150, amount: 500 },
];

export const MIN_SALARY_STAGE =
  SALARY_RULES.length > 0 ? Math.min(...SALARY_RULES.map((r) => r.stage)) : 2;
export const MAX_SALARY_STAGE =
  SALARY_RULES.length > 0 ? Math.max(...SALARY_RULES.map((r) => r.stage)) : 2;

/** Next salary milestone stage after `lastClaimedStage` (0 = never claimed). Legacy stage-1 claims remain in history only. */
export const nextSalaryStageAfterClaim = (lastClaimedStage) => {
  const last = Number(lastClaimedStage ?? 0);
  if (!Number.isFinite(last) || last < 0) return MIN_SALARY_STAGE;
  if (last === 0) return MIN_SALARY_STAGE;
  return last + 1;
};

export const REFERRAL_RATES = [
  { depth: 1, rate: 0.1 },
  { depth: 2, rate: 0.06 },
  { depth: 3, rate: 0.05 },
];

export const STAKE_PLANS = {
  7: { days: 7, dailyRate: 0.013 },
  15: { days: 15, dailyRate: 0.015 },
  30: { days: 30, dailyRate: 0.018 },
  60: { days: 60, dailyRate: 0.022 },
};

export const WITHDRAW_MIN_AMOUNT = 50;
export const WITHDRAW_FEE_RATE = 0.05;

export const WITHDRAW_MONTHLY_LIMITS = {
  0: 0,
  1: 500,
  2: 2000,
  3: 5000,
};

export const BSC_USDT_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

/** BEP20 deposit minimum (USDT) — must match deposit listener & UI */
export const MIN_HYBRID_DEPOSIT = 1;
