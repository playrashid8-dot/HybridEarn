import User from "../../models/User.js";
import { normalizeEvmAddress } from "./normalizeWallet.js";
import { userMap } from "../services/userMap.js";

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
      (addressesLower || [])
        .map((a) => normalizeEvmAddress(a))
        .filter((a) => a && a.startsWith("0x") && a.length >= 42),
    ),
  ];
  const misses = [];
  for (const addr of uniq) {
    const hit = userMap.get(addr);
    if (hit && hit._id) {
      const k = normalizeEvmAddress(hit.walletAddress || addr);
      if (k) {
        out.set(k, { _id: hit._id, walletAddress: k });
      }
      continue;
    }
    misses.push(addr);
  }
  if (misses.length === 0) {
    return out;
  }
  const rows = await findUsersByWalletAddressesLowercase(misses);
  for (const u of rows) {
    const k = normalizeEvmAddress(u.walletAddress);
    if (k) {
      out.set(k, { _id: u._id, walletAddress: k });
    }
  }
  return out;
}

/**
 * Resolve users whose `walletAddress` matches any of `addressesLower` (case-insensitive, trimmed).
 * Required for deposit detection: chain/logs use lowercase; DB may store EIP-55 mixed case.
 */
export async function findUsersByWalletAddressesLowercase(addressesLower) {
  const uniq = [
    ...new Set(
      (addressesLower || []).map((a) => normalizeEvmAddress(a)).filter((a) => a && a.startsWith("0x") && a.length >= 42),
    ),
  ];
  if (uniq.length === 0) return [];

  return User.aggregate([
    {
      $match: {
        walletAddress: { $exists: true, $type: "string", $nin: [null, ""] },
        $expr: {
          $in: [
            {
              $toLower: {
                $trim: { input: { $ifNull: ["$walletAddress", ""] } },
              },
            },
            uniq,
          ],
        },
      },
    },
    { $project: { _id: 1, walletAddress: 1 } },
  ]);
}

/** Build `Map<lowercaseWallet, user>` for `processDepositLog(usersByWallet.get)`. */
export function usersMapFromAggregate(users) {
  const usersByWallet = new Map();
  for (const user of users) {
    const k = normalizeEvmAddress(user.walletAddress);
    if (k) usersByWallet.set(k, user);
  }
  return usersByWallet;
}

export async function findUserByWalletLowercase(addressLower) {
  const want = normalizeEvmAddress(addressLower);
  if (!want || !want.startsWith("0x") || want.length < 42) return null;
  const cached = userMap.get(want);
  if (cached && cached._id) {
    return {
      _id: cached._id,
      walletAddress: normalizeEvmAddress(cached.walletAddress || want),
    };
  }

  const rows = await User.aggregate([
    {
      $match: {
        walletAddress: { $exists: true, $type: "string", $nin: [null, ""] },
        $expr: {
          $eq: [
            {
              $toLower: {
                $trim: { input: { $ifNull: ["$walletAddress", ""] } },
              },
            },
            want,
          ],
        },
      },
    },
    { $limit: 1 },
    { $project: { _id: 1, walletAddress: 1 } },
  ]);
  return rows[0] || null;
}
