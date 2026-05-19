import User from "../../models/User.js";
import { normalizeEvmAddress } from "./normalizeWallet.js";
import { userMap } from "../services/userMap.js";
import logger from "../../utils/logger.js";

const WALLET_LOOKUP_CACHE_MAX = Math.min(
  250_000,
  Math.max(1_000, Number(process.env.HYBRID_WALLET_LOOKUP_CACHE_MAX || 50_000)),
);
const KNOWN_WALLET_CACHE_TTL_MS = Math.min(
  3_600_000,
  Math.max(60_000, Number(process.env.HYBRID_KNOWN_WALLET_CACHE_TTL_MS || 900_000)),
);
const UNKNOWN_WALLET_CACHE_TTL_MS = Math.min(
  600_000,
  Math.max(10_000, Number(process.env.HYBRID_UNKNOWN_WALLET_CACHE_TTL_MS || 60_000)),
);

const knownWalletCache = new Map();
const unknownWalletCache = new Map();

export function isValidEvmAddress(addr) {
  return /^0x[0-9a-f]{40}$/.test(normalizeEvmAddress(addr));
}

export function resolveUserWalletKey(user) {
  const candidates = [user?.normalizedAddress, user?.depositAddress, user?.walletAddress];
  for (const candidate of candidates) {
    const normalized = normalizeEvmAddress(candidate);
    if (isValidEvmAddress(normalized)) {
      return normalized;
    }
  }
  return "";
}

function isWalletDisabled(user) {
  return user?.isActive === false || user?.hybridEnabled === false;
}

function walletLogMeta(address, user = null) {
  return {
    walletTail: `${normalizeEvmAddress(address).slice(-8)}`,
    userTail: user?._id ? `${String(user._id).slice(-8)}` : undefined,
    walletVersion: user?.walletVersion ?? null,
  };
}

function pruneWalletLookupCache(cache) {
  if (cache.size <= WALLET_LOOKUP_CACHE_MAX) {
    return;
  }

  const now = Date.now();
  for (const [key, value] of cache) {
    const expiresAt = typeof value === "number" ? value : value?.expiresAt;
    if (expiresAt <= now || cache.size > WALLET_LOOKUP_CACHE_MAX) {
      cache.delete(key);
    }
    if (cache.size <= WALLET_LOOKUP_CACHE_MAX) {
      break;
    }
  }
}

function getKnownWalletCache(address) {
  const normalized = normalizeEvmAddress(address);
  const cached = knownWalletCache.get(normalized);
  if (!cached || cached.expiresAt <= Date.now()) {
    knownWalletCache.delete(normalized);
    return null;
  }
  return cached.user || null;
}

function setKnownWalletCache(address, user) {
  const normalized = normalizeEvmAddress(address);
  if (!isValidEvmAddress(normalized) || !user?._id) {
    return;
  }
  unknownWalletCache.delete(normalized);
  knownWalletCache.set(normalized, {
    user: { ...user, walletAddress: normalized },
    expiresAt: Date.now() + KNOWN_WALLET_CACHE_TTL_MS,
  });
  pruneWalletLookupCache(knownWalletCache);
}

function hasUnknownWalletCache(address) {
  const normalized = normalizeEvmAddress(address);
  const expiresAt = unknownWalletCache.get(normalized);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    unknownWalletCache.delete(normalized);
    return false;
  }
  return true;
}

function setUnknownWalletCache(address) {
  const normalized = normalizeEvmAddress(address);
  if (!isValidEvmAddress(normalized)) {
    return;
  }
  unknownWalletCache.set(normalized, Date.now() + UNKNOWN_WALLET_CACHE_TTL_MS);
  pruneWalletLookupCache(unknownWalletCache);
}

async function selfHealNormalizedAddress(user, normalized, source) {
  if (!user?._id || !isValidEvmAddress(normalized) || normalizeEvmAddress(user.normalizedAddress)) {
    return;
  }

  try {
    const result = await User.updateOne(
      {
        _id: user._id,
        $or: [
          { normalizedAddress: { $exists: false } },
          { normalizedAddress: null },
          { normalizedAddress: "" },
        ],
      },
      {
        $set: {
          normalizedAddress: normalized,
        },
      },
    );

    if (result.modifiedCount > 0) {
      logger.info("DEPOSIT_WALLET_NORMALIZED_SELF_HEALED", {
        ...walletLogMeta(normalized, user),
        source,
      });
      user.normalizedAddress = normalized;
    }
  } catch (err) {
    logger.warn("DEPOSIT_WALLET_NORMALIZED_SELF_HEAL_FAILED", {
      ...walletLogMeta(normalized, user),
      source,
      error: err?.message || String(err),
    });
  }
}

async function mapMatchedUser(out, address, user, source) {
  const normalized = normalizeEvmAddress(address);
  if (!isValidEvmAddress(normalized)) {
    return;
  }

  if (isWalletDisabled(user)) {
    logger.throttledInfo(
      `deposit_wallet_inactive:${normalized}`,
      "DEPOSIT_WALLET_SKIPPED_INACTIVE",
      {
        ...walletLogMeta(normalized, user),
        isActive: user?.isActive ?? null,
        hybridEnabled: user?.hybridEnabled ?? null,
        source,
      },
    );
    return;
  }

  await selfHealNormalizedAddress(user, normalized, source);

  if (out.has(normalized)) {
    const existing = out.get(normalized);
    logger.warn("DEPOSIT_WALLET_MATCH_DUPLICATE_ADDRESS", {
      walletTail: `${normalized.slice(-8)}`,
      existingUserTail: existing?._id ? `${String(existing._id).slice(-8)}` : undefined,
      skippedUserTail: user?._id ? `${String(user._id).slice(-8)}` : undefined,
      source,
    });
    return;
  }

  out.set(normalized, { ...user, walletAddress: normalized });
  logger.debug?.("DEPOSIT_WALLET_MATCHED", {
    ...walletLogMeta(normalized, user),
    source,
    normalizedLookupUsed: true,
  });
}

/**
 * Build recipient → user map: O(1) hits from cached `userMap`, Mongo aggregate only for cache misses.
 * Keeps scan/recovery paths from issuing wide User queries when the registry is warm.
 *
 * @param {readonly string[]} addressesLower lowercase 0x-prefixed EVM wallets (normalized)
 * @returns {Promise<Map<string, {_id: unknown, walletAddress: string}>>}
 */
export async function resolveRecipientsUsersByWalletMap(addressesLower) {
  /** @type {Map<string, {_id: unknown, walletAddress: string}>} */
  const out = new Map();
  const uniq = [
    ...new Set(
      (addressesLower || []).map((a) => normalizeEvmAddress(a)).filter(isValidEvmAddress),
    ),
  ];
  const uniqSet = new Set(uniq);
  const misses = [];
  for (const addr of uniq) {
    const hit = userMap.get(addr);
    if (hit && hit._id) {
      setKnownWalletCache(addr, hit);
      await mapMatchedUser(out, addr, hit, "cache");
      continue;
    }
    const knownCached = getKnownWalletCache(addr);
    if (knownCached && knownCached._id) {
      await mapMatchedUser(out, addr, knownCached, "lookup_cache");
      continue;
    }
    if (hasUnknownWalletCache(addr)) {
      continue;
    }
    misses.push(addr);
  }
  if (misses.length === 0) {
    return out;
  }
  const rows = await findUsersByWalletAddressesLowercase(misses);
  for (const u of rows) {
    const matchedKeys = [
      normalizeEvmAddress(u.normalizedAddress),
      normalizeEvmAddress(u.depositAddress),
      normalizeEvmAddress(u.walletAddress),
    ].filter((candidate) => isValidEvmAddress(candidate) && uniqSet.has(candidate));
    for (const k of matchedKeys) {
      await mapMatchedUser(out, k, u, "mongo");
      setKnownWalletCache(k, u);
    }
  }
  for (const addr of misses) {
    if (!out.has(addr)) {
      setUnknownWalletCache(addr);
    }
  }
  return out;
}

/**
 * Resolve users whose normalized/deposit/wallet address matches any requested recipient.
 * Required for deposit detection: chain/logs use lowercase; legacy DB rows may be mixed case or missing normalizedAddress.
 */
export async function findUsersByWalletAddressesLowercase(addressesLower) {
  const uniq = [
    ...new Set(
      (addressesLower || []).map((a) => normalizeEvmAddress(a)).filter(isValidEvmAddress),
    ),
  ];
  if (uniq.length === 0) return [];

  return User.aggregate([
    {
      $match: {
        $or: [
          { normalizedAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
          { depositAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
          { walletAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
        ],
      },
    },
    {
      $addFields: {
        normalizedAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$normalizedAddress", ""] } } },
        },
        depositAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$depositAddress", ""] } } },
        },
        walletAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$walletAddress", ""] } } },
        },
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $in: ["$normalizedAddressLower", uniq] },
            { $in: ["$depositAddressLower", uniq] },
            { $in: ["$walletAddressLower", uniq] },
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        walletAddress: 1,
        depositAddress: 1,
        normalizedAddress: 1,
        hybridEnabled: 1,
        isActive: 1,
        walletVersion: 1,
      },
    },
  ]);
}

/** Build `Map<lowercaseWallet, user>` for `processDepositLog(usersByWallet.get)`. */
export function usersMapFromAggregate(users) {
  const usersByWallet = new Map();
  for (const user of users) {
    const k = resolveUserWalletKey(user);
    if (k) usersByWallet.set(k, user);
  }
  return usersByWallet;
}

export async function findUserByWalletLowercase(addressLower) {
  const want = normalizeEvmAddress(addressLower);
  if (!isValidEvmAddress(want)) return null;
  const cached = userMap.get(want);
  if (cached && cached._id) {
    setKnownWalletCache(want, cached);
    if (isWalletDisabled(cached)) {
      logger.throttledInfo(
        `deposit_wallet_inactive:${want}`,
        "DEPOSIT_WALLET_SKIPPED_INACTIVE",
        {
          ...walletLogMeta(want, cached),
          isActive: cached?.isActive ?? null,
          hybridEnabled: cached?.hybridEnabled ?? null,
          source: "cache_single",
        },
      );
      return null;
    }
    await selfHealNormalizedAddress(cached, want, "cache_single");
    logger.debug?.("DEPOSIT_WALLET_MATCHED", {
      ...walletLogMeta(want, cached),
      source: "cache_single",
      normalizedLookupUsed: true,
    });
    return {
      _id: cached._id,
      walletAddress: want,
      depositAddress: cached.depositAddress,
      normalizedAddress: cached.normalizedAddress || want,
      hybridEnabled: cached.hybridEnabled,
      isActive: cached.isActive,
      walletVersion: cached.walletVersion,
    };
  }

  const knownCached = getKnownWalletCache(want);
  if (knownCached && knownCached._id) {
    if (isWalletDisabled(knownCached)) {
      logger.throttledInfo(
        `deposit_wallet_inactive:${want}`,
        "DEPOSIT_WALLET_SKIPPED_INACTIVE",
        {
          ...walletLogMeta(want, knownCached),
          isActive: knownCached?.isActive ?? null,
          hybridEnabled: knownCached?.hybridEnabled ?? null,
          source: "lookup_cache_single",
        },
      );
      return null;
    }
    await selfHealNormalizedAddress(knownCached, want, "lookup_cache_single");
    logger.debug?.("DEPOSIT_WALLET_MATCHED", {
      ...walletLogMeta(want, knownCached),
      source: "lookup_cache_single",
      normalizedLookupUsed: true,
    });
    return {
      _id: knownCached._id,
      walletAddress: want,
      depositAddress: knownCached.depositAddress,
      normalizedAddress: knownCached.normalizedAddress || want,
      hybridEnabled: knownCached.hybridEnabled,
      isActive: knownCached.isActive,
      walletVersion: knownCached.walletVersion,
    };
  }

  if (hasUnknownWalletCache(want)) {
    return null;
  }

  const rows = await User.aggregate([
    {
      $match: {
        $or: [
          { normalizedAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
          { depositAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
          { walletAddress: { $exists: true, $type: "string", $nin: [null, ""] } },
        ],
      },
    },
    {
      $addFields: {
        normalizedAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$normalizedAddress", ""] } } },
        },
        depositAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$depositAddress", ""] } } },
        },
        walletAddressLower: {
          $toLower: { $trim: { input: { $ifNull: ["$walletAddress", ""] } } },
        },
      },
    },
    {
      $match: {
        $expr: {
          $or: [
            { $eq: ["$normalizedAddressLower", want] },
            { $eq: ["$depositAddressLower", want] },
            { $eq: ["$walletAddressLower", want] },
          ],
        },
      },
    },
    { $limit: 1 },
    {
      $project: {
        _id: 1,
        walletAddress: 1,
        depositAddress: 1,
        normalizedAddress: 1,
        hybridEnabled: 1,
        isActive: 1,
        walletVersion: 1,
      },
    },
  ]);
  const user = rows[0] || null;
  if (!user) {
    setUnknownWalletCache(want);
    return null;
  }
  if (isWalletDisabled(user)) {
    logger.throttledInfo(
      `deposit_wallet_inactive:${want}`,
      "DEPOSIT_WALLET_SKIPPED_INACTIVE",
      {
        ...walletLogMeta(want, user),
        isActive: user?.isActive ?? null,
        hybridEnabled: user?.hybridEnabled ?? null,
        source: "mongo_single",
      },
    );
    return null;
  }
  await selfHealNormalizedAddress(user, want, "mongo_single");
  setKnownWalletCache(want, user);
  logger.debug?.("DEPOSIT_WALLET_MATCHED", {
    ...walletLogMeta(want, user),
    source: "mongo_single",
    normalizedLookupUsed: true,
  });
  return { ...user, walletAddress: want };
}
