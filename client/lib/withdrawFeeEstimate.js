import { UI_WITHDRAW_FEE_RATE_FALLBACK } from "./constants";

/**
 * Infer effective fee rate from recent withdrawals (matches server rounding when history exists).
 * Falls back to UI mirror rate when unknown — display estimate only.
 */
export function inferWithdrawFeeRate(withdrawals) {
  const list = Array.isArray(withdrawals) ? withdrawals : [];
  const ratios = [];
  for (const w of list) {
    const gross = Number(w?.grossAmount ?? 0);
    const fee = Number(w?.feeAmount ?? 0);
    if (gross > 0 && Number.isFinite(fee) && fee >= 0) {
      ratios.push(fee / gross);
    }
  }
  if (!ratios.length) return UI_WITHDRAW_FEE_RATE_FALLBACK;
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Number.isFinite(avg) && avg >= 0 && avg < 1 ? avg : UI_WITHDRAW_FEE_RATE_FALLBACK;
}

/** Estimated net receive in USDT for preview (does not submit anything). */
export function estimateWithdrawNetUsd(grossUsd, withdrawals) {
  const rate = inferWithdrawFeeRate(withdrawals);
  const gross = Number(grossUsd ?? 0);
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  const net = gross * (1 - rate);
  return Math.max(0, Number(net.toFixed(2)));
}
