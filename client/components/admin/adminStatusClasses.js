/** Solid badge colors for unknown / generic status (fallback UX) */
export function getStatusClass(status) {
  if (!status) return "bg-gray-500";

  switch (String(status).toLowerCase()) {
    case "pending":
    case "claimable":
      return "bg-yellow-500";
    case "approved":
      return "bg-blue-500";
    case "paid":
    case "claimed":
      return "bg-green-500";
    case "rejected":
    case "failed":
      return "bg-red-500";
    default:
      return "bg-gray-500";
  }
}

/** Withdrawal / generic admin status → Tailwind badge classes (pending=yellow, paid=green, rejected=red) */
export function withdrawalStatusClasses(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "claimed") return "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30";
  if (s === "processing") return "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/35";
  if (s === "rejected" || s === "failed") return "bg-red-500/20 text-red-300 ring-1 ring-red-500/30";
  if (s === "review")
    return "bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-500/35";
  if (s === "pending" || s === "claimable")
    return "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/35";
  if (s === "approved")
    return "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/30";
  return "bg-white/10 text-gray-300 ring-1 ring-white/15";
}

/** Hybrid deposit status → badge classes */
export function depositStatusClasses(status) {
  const s = String(status || "").toLowerCase();
  if (s === "failed") return "bg-red-500/20 text-red-300 ring-1 ring-red-500/30";
  if (s === "detected") return "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/35";
  if (s === "credited" || s === "swept")
    return "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30";
  return "bg-white/10 text-gray-300 ring-1 ring-white/15";
}
