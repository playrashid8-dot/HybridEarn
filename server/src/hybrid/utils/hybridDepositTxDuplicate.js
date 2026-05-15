import HybridDeposit from "../models/HybridDeposit.js";
import HybridLedger from "../models/HybridLedger.js";

/**
 * Skip processing when tx is finalized on HybridDeposit or already credited in HybridLedger.
 * @param {import("mongoose").ClientSession | null} [session]
 */
export async function shouldSkipDepositForDuplicateTx(txHash, session = null) {
  const normalized = String(txHash || "").trim().toLowerCase();
  if (!normalized) return { skip: false };

  let depQuery = HybridDeposit.findOne({ txHash: normalized }).select("_id status");
  if (session) depQuery = depQuery.session(session);
  const existing = await depQuery.lean();

  if (existing && ["credited", "swept"].includes(String(existing.status))) {
    return { skip: true, reason: "deposit", status: existing.status };
  }

  let ledgerQuery = HybridLedger.findOne({
    source: "hybrid_deposit",
    entryType: "credit",
    "meta.txHash": normalized,
  }).select("_id");
  if (session) ledgerQuery = ledgerQuery.session(session);
  const ledgerHit = await ledgerQuery.lean();

  if (ledgerHit) {
    return { skip: true, reason: "ledger" };
  }

  return { skip: false };
}
