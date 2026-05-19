import "../src/config/loadEnv.js";
import connectDB, { gracefulDisconnectMongo } from "../src/config/db.js";
import { connectRedisInBackground, disconnectRedisQuietly } from "../src/config/redis.js";
import { auditRoiRecoveryState } from "../src/hybrid/services/roiRecoveryService.js";
import { payoutQueue } from "../src/queues/payoutQueue.js";

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  await connectDB();
  await connectRedisInBackground().catch(() => null);

  const report = await auditRoiRecoveryState({
    limit: getArg("limit", 100),
    staleMinutes: getArg("stale-minutes", 30),
    ledgerDays: getArg("ledger-days", 14),
  });

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error("ROI recovery audit failed:", err?.message || String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await payoutQueue?.close?.().catch(() => {});
    await disconnectRedisQuietly().catch(() => {});
    await gracefulDisconnectMongo("roi recovery audit script").catch(() => {});
  });
