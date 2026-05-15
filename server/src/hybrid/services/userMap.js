import User from "../../models/User.js";
import { normalizeEvmAddress } from "../utils/normalizeWallet.js";
import logger from "../../utils/logger.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";

export const userMap = new Map();

/** Avoid spamming while waitForDepositWalletsInMap polls every 5s on empty DB. */
let lastNoUsersOnboardingWarnAt = 0;
const NO_USERS_ONBOARDING_WARN_COOLDOWN_MS = 60_000;

/** Updated on each successful DB sync (initial + periodic). */
let lastSync = Date.now();

export function getUserMapLastSync() {
  return lastSync;
}

async function refillUserMapFromDb() {
  const users = await User.find({}, "walletAddress _id").lean();

  userMap.clear();

  if (users.length === 0) {
    const now = Date.now();
    if (now - lastNoUsersOnboardingWarnAt >= NO_USERS_ONBOARDING_WARN_COOLDOWN_MS) {
      logger.warn("No users in DB — ready for onboarding", {});
      lastNoUsersOnboardingWarnAt = now;
    }
  }

  for (const user of users) {
    const key = normalizeEvmAddress(user.walletAddress);
    if (!key) {
      continue;
    }
    userMap.set(key, {
      ...user,
      walletAddress: key,
    });
  }
}

export async function loadUsersIntoRealtimeMap() {
  await refillUserMapFromDb();
  lastSync = Date.now();
  logger.debug?.("Hybrid deposit user map loaded", { count: userMap.size });
}

/**
 * Reload from DB until at least one wallet exists or retries exhausted (startup race / empty DB).
 */
export async function waitForDepositWalletsInMap() {
  const maxEmptyRetries = 60;
  let emptyRetries = 0;

  while (userMap.size === 0 && emptyRetries < maxEmptyRetries) {
    await loadUsersIntoRealtimeMap();
    if (userMap.size > 0) {
      return userMap.size;
    }
    emptyRetries += 1;
    logger.warn("User map empty — reloading from DB; blocking listener start", {
      attempt: emptyRetries + 1,
    });
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (userMap.size === 0) {
    logger.warn(
      "No deposit wallets in DB after retries — listener will start; deposits match once users exist",
      {},
    );
  }

  return userMap.size;
}

let periodicRefreshStarted = false;

/** Full refresh cadence from `depositPipelineConfig.userMapRefreshMs` — single path with initial load. */
export function startUserMapPeriodicRefresh() {
  if (periodicRefreshStarted) {
    return;
  }
  periodicRefreshStarted = true;

  const refreshMs = depositPipelineConfig.userMapRefreshMs;
  setInterval(async () => {
    try {
      if (userMap.size === 0) {
        logger.debug?.("User map empty — periodic DB reload", {});
      }
      await refillUserMapFromDb();
      lastSync = Date.now();
      logger.debug?.("User map refreshed", { count: userMap.size });
    } catch (err) {
      logger.error("User map sync failed", { error: err?.message || String(err) });
    }
  }, refreshMs);
}

/**
 * Keep the in-memory wallet map in sync when a new user is created (signup).
 */
export function addUserToHybridDepositRealtimeMap(userDoc) {
  const lower = normalizeEvmAddress(userDoc?.walletAddress);
  if (!lower) {
    return;
  }
  userMap.set(lower, {
    _id: userDoc._id,
    walletAddress: lower,
  });
}
