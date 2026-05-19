import "../src/config/loadEnv.js";
import connectDB, { gracefulDisconnectMongo } from "../src/config/db.js";
import User from "../src/models/User.js";
import logger from "../src/utils/logger.js";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const LIMIT = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 0);
const VALID_EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAddress(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_EVM_ADDRESS.test(normalized) ? normalized : "";
}

function selectedAddressSource(user) {
  if (hasValue(user.depositAddress)) {
    return { raw: user.depositAddress, source: "depositAddress" };
  }
  if (hasValue(user.walletAddress)) {
    return { raw: user.walletAddress, source: "walletAddress" };
  }
  return { raw: "", source: "none" };
}

function deriveNormalizedAddress(user) {
  return normalizeAddress(selectedAddressSource(user).raw);
}

async function getWalletFieldAudit() {
  const audit = {
    totalUsers: 0,
    withWalletAddress: 0,
    withDepositAddress: 0,
    withNormalizedAddress: 0,
    missingNormalizedAddress: 0,
    invalidWallets: 0,
    nullAddressSources: 0,
    nonLowercaseWalletAddress: 0,
    nonLowercaseDepositAddress: 0,
    nonLowercaseNormalizedAddress: 0,
    explicitInactive: 0,
    explicitHybridDisabled: 0,
    walletVersion2Plus: 0,
    legacyWalletVersion: 0,
  };

  const cursor = User.find({})
    .select("depositAddress walletAddress normalizedAddress hybridEnabled isActive walletVersion")
    .lean()
    .cursor();

  for await (const user of cursor) {
    audit.totalUsers += 1;
    if (hasValue(user.walletAddress)) audit.withWalletAddress += 1;
    if (hasValue(user.depositAddress)) audit.withDepositAddress += 1;
    if (hasValue(user.normalizedAddress)) audit.withNormalizedAddress += 1;
    if (!hasValue(user.normalizedAddress)) audit.missingNormalizedAddress += 1;
    if (user.isActive === false) audit.explicitInactive += 1;
    if (user.hybridEnabled === false) audit.explicitHybridDisabled += 1;
    if (Number(user.walletVersion) >= 2) audit.walletVersion2Plus += 1;
    if (user.walletVersion == null || Number(user.walletVersion) < 2) audit.legacyWalletVersion += 1;

    if (hasValue(user.walletAddress) && user.walletAddress !== String(user.walletAddress).toLowerCase()) {
      audit.nonLowercaseWalletAddress += 1;
    }
    if (hasValue(user.depositAddress) && user.depositAddress !== String(user.depositAddress).toLowerCase()) {
      audit.nonLowercaseDepositAddress += 1;
    }
    if (
      hasValue(user.normalizedAddress) &&
      user.normalizedAddress !== String(user.normalizedAddress).toLowerCase()
    ) {
      audit.nonLowercaseNormalizedAddress += 1;
    }

    const selected = selectedAddressSource(user);
    if (!hasValue(selected.raw)) {
      audit.nullAddressSources += 1;
    } else if (!normalizeAddress(selected.raw)) {
      audit.invalidWallets += 1;
    }
  }

  return audit;
}

async function getDuplicateNormalizedCandidates() {
  const duplicates = await User.aggregate([
    {
      $project: {
        normalizedCandidate: {
          $toLower: {
            $trim: {
              input: {
                $cond: [
                  { $gt: [{ $strLenCP: { $ifNull: ["$depositAddress", ""] } }, 0] },
                  "$depositAddress",
                  { $ifNull: ["$walletAddress", ""] },
                ],
              },
            },
          },
        },
      },
    },
    { $match: { normalizedCandidate: { $regex: "^0x[0-9a-f]{40}$" } } },
    { $group: { _id: "$normalizedCandidate", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return {
    count: duplicates.length,
    examples: duplicates.slice(0, 20),
  };
}

async function main() {
  await connectDB();

  const auditBefore = await getWalletFieldAudit();
  const duplicateCandidates = await getDuplicateNormalizedCandidates();
  const query = {
    $or: [
      { normalizedAddress: { $exists: false } },
      { normalizedAddress: null },
      { normalizedAddress: "" },
    ],
  };
  const userQuery = User.find(query).select(
    "_id username email depositAddress walletAddress normalizedAddress hybridEnabled isActive walletVersion",
  );
  if (Number.isFinite(LIMIT) && LIMIT > 0) {
    userQuery.limit(LIMIT);
  }
  const cursor = userQuery.cursor();

  const result = {
    apply: APPLY,
    auditBefore,
    duplicateCandidateCount: duplicateCandidates.count,
    duplicateCandidates: duplicateCandidates.examples.map((row) => ({
      walletTail: String(row._id).slice(-8),
      count: row.count,
    })),
    scanned: 0,
    alreadyNormalized: auditBefore.withNormalizedAddress,
    backfilled: 0,
    dryRunBackfillable: 0,
    skippedInvalidOrNull: 0,
    skippedInvalidDepositAddressWithWalletFallbackAvailable: 0,
    examples: [],
  };

  if (APPLY && duplicateCandidates.count > 0) {
    throw new Error(
      `Duplicate normalized wallet candidates detected (${duplicateCandidates.count}); aborting apply`,
    );
  }

  for await (const user of cursor) {
    result.scanned += 1;

    const selected = selectedAddressSource(user);
    const normalizedAddress = deriveNormalizedAddress(user);
    if (!normalizedAddress) {
      result.skippedInvalidOrNull += 1;
      if (selected.source === "depositAddress" && normalizeAddress(user.walletAddress)) {
        result.skippedInvalidDepositAddressWithWalletFallbackAvailable += 1;
      }
      continue;
    }

    if (!APPLY) {
      result.dryRunBackfillable += 1;
    } else {
      const update = await User.updateOne(
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
            normalizedAddress,
            walletVersion: 2,
          },
        },
      );
      result.backfilled += update.modifiedCount || 0;
    }

    if (result.examples.length < 10) {
      result.examples.push({
        userId: String(user._id),
        walletTail: normalizedAddress.slice(-8),
        source: selected.source,
      });
    }
  }

  result.auditAfter = APPLY ? await getWalletFieldAudit() : null;

  logger.warn("normalized wallet backfill finished", {
    apply: APPLY,
    scanned: result.scanned,
    backfilled: result.backfilled,
    dryRunBackfillable: result.dryRunBackfillable,
    skippedInvalidOrNull: result.skippedInvalidOrNull,
    duplicateCandidateCount: result.duplicateCandidateCount,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    logger.error("normalized wallet backfill failed", { error: error?.message || String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await gracefulDisconnectMongo("normalized wallet backfill");
  });
