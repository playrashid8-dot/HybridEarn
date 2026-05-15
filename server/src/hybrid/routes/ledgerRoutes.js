import express from "express";
import auth from "../../middleware/auth.js";
import HybridLedger from "../models/HybridLedger.js";

const router = express.Router();

/**
 * User-facing hybrid ledger (immutable source of truth).
 * Excludes internal split lines (e.g. withdraw_request debits from reward/deposit buckets).
 */
const LEDGER_OR = [
  {
    source: {
      $in: [
        "hybrid_deposit",
        "roi_claim",
        "referral_bonus",
        "roi_referral_bonus",
        "first_deposit_bonus",
        "salary_claim",
        "withdraw_payout",
      ],
    },
  },
  { source: "withdraw_request", balanceType: "pendingWithdraw", entryType: "credit" },
  { source: "withdraw_reject", entryType: "credit" },
];

function maskRefSource(fromUserId) {
  if (fromUserId == null || fromUserId === "") return null;
  const s = String(fromUserId);
  if (/^[a-f0-9]{24}$/i.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  if (s.length > 14) return `${s.slice(0, 8)}…`;
  return s;
}

function ledgerRowToDisplay(doc) {
  const meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  const rawAmount = Number(doc.amount || 0);

  let displayType = "other";
  if (doc.source === "hybrid_deposit") displayType = "deposit";
  else if (doc.source === "withdraw_request" || doc.source === "withdraw_payout") displayType = "withdraw";
  else if (doc.source === "withdraw_reject") displayType = "withdraw";
  else if (doc.source === "roi_claim") displayType = "roi";
  else if (doc.source === "referral_bonus") displayType = "referral";
  else if (doc.source === "roi_referral_bonus") displayType = "referral";
  else if (doc.source === "first_deposit_bonus") displayType = "first_deposit_bonus";
  else if (doc.source === "salary_claim") displayType = "salary";

  let displayAmount = 0;
  let status = "credited";
  let detail = "";

  if (doc.source === "hybrid_deposit") {
    displayAmount = rawAmount;
    status = "credited";
    detail = meta.txHash ? `TX ${String(meta.txHash).slice(0, 10)}…` : "";
  } else if (doc.source === "roi_claim") {
    displayAmount = rawAmount;
    const pct = meta.roiRate != null ? Number(meta.roiRate) * 100 : null;
    detail =
      pct != null && Number.isFinite(pct)
        ? `Rate ${pct >= 10 || pct === Math.round(pct) ? pct.toFixed(0) : pct.toFixed(2)}%`
        : "";
    if (meta.level != null) detail = detail ? `${detail} · L${meta.level}` : `L${meta.level}`;
  } else if (doc.source === "referral_bonus") {
    displayAmount = rawAmount;
    const lvl = meta.depth != null ? `Level ${meta.depth}` : "";
    const src = maskRefSource(meta.fromUserId);
    detail = [lvl, src ? `source ${src}` : ""].filter(Boolean).join(" · ");
  } else if (doc.source === "roi_referral_bonus") {
    displayAmount = rawAmount;
    const lvl = meta.depth != null ? `Level ${meta.depth}` : "";
    const src = maskRefSource(meta.fromUserId);
    const basis =
      meta.roiClaimAmount != null && Number.isFinite(Number(meta.roiClaimAmount))
        ? `from ROI claim $${Number(meta.roiClaimAmount).toFixed(2)}`
        : "from team ROI claim";
    detail = ["Team ROI income", lvl, basis, src ? `member ${src}` : ""].filter(Boolean).join(" · ");
  } else if (doc.source === "first_deposit_bonus") {
    displayAmount = rawAmount;
    const amt =
      meta.depositAmount != null && Number.isFinite(Number(meta.depositAmount))
        ? Number(meta.depositAmount).toFixed(2)
        : null;
    const tier = meta.rewardTier != null ? String(meta.rewardTier) : "";
    const src = maskRefSource(meta.fromUserId);
    detail = [
      "Direct downline first deposit",
      amt != null ? `$${amt} deposit` : "",
      tier ? `tier ${tier}` : "",
      src ? `member ${src}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (doc.source === "salary_claim") {
    displayAmount = rawAmount;
    detail = meta.stage != null ? `Stage ${meta.stage}` : "";
  } else if (doc.source === "withdraw_request") {
    displayAmount = -Math.abs(rawAmount);
    status = "pending";
    const net = meta.netAmount != null ? Number(meta.netAmount) : null;
    const fee = meta.feeAmount != null ? Number(meta.feeAmount) : null;
    const parts = [];
    if (net != null && Number.isFinite(net)) parts.push(`Net $${net.toFixed(2)}`);
    if (fee != null && Number.isFinite(fee) && fee > 0) parts.push(`Fee $${fee.toFixed(2)}`);
    detail = parts.join(" · ");
  } else if (doc.source === "withdraw_payout") {
    const net = meta.netAmount != null ? Number(meta.netAmount) : null;
    displayAmount = net != null && Number.isFinite(net) ? Math.abs(net) : -Math.abs(rawAmount);
    status = "completed";
    const parts = [];
    if (meta.txHash) parts.push(`TX ${String(meta.txHash).slice(0, 10)}…`);
    if (meta.walletAddress)
      parts.push(`${String(meta.walletAddress).slice(0, 6)}…${String(meta.walletAddress).slice(-4)}`);
    detail = parts.join(" · ");
  } else if (doc.source === "withdraw_reject" && doc.entryType === "credit") {
    displayAmount = rawAmount;
    status = "refunded";
    detail = "Withdrawal returned to balance";
  }

  const typeLabel =
    displayType === "deposit"
      ? "Deposit"
      : displayType === "withdraw"
        ? "Withdraw"
        : displayType === "roi"
          ? "ROI"
          : displayType === "referral"
            ? doc.source === "roi_referral_bonus"
              ? "Team ROI income"
              : "Referral"
            : displayType === "first_deposit_bonus"
              ? "First deposit bonus"
            : displayType === "salary"
              ? "Salary"
              : "Other";

  return {
    _id: doc._id,
    createdAt: doc.createdAt,
    source: doc.source,
    displayType,
    typeLabel,
    displayAmount,
    status,
    detail,
  };
}

router.get("/", auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    const rows = await HybridLedger.find({
      userId: req.user._id,
      $or: LEDGER_OR,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const entries = rows.map(ledgerRowToDisplay);

    res.json({
      success: true,
      msg: "Ledger fetched",
      data: { entries },
    });
  } catch (err) {
    console.error("GET /hybrid/ledger:", err?.message || err);
    res.status(500).json({ success: false, msg: "Could not load ledger", data: null });
  }
});

export default router;
