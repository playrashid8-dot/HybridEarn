/** User-facing withdrawal labels (UI only; backend statuses unchanged). */

export function getWithdrawalBadgeVariant(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "claimed") return "completed";
  if (s === "rejected") return "rejected";
  if (s === "approved") return "approved";
  return "pending";
}

export function getWithdrawalStatusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "claimed") return "Completed";
  if (s === "rejected") return "Rejected";
  if (s === "approved") return "Approved";
  return "Pending";
}
