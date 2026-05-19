"use client";

import type { ReactNode } from "react";

/** Maps arbitrary API statuses to badge tier — UI only. */
export function resolveStatusTier(raw: string): "success" | "warning" | "danger" | "muted" {
  const s = String(raw || "").toLowerCase();

  if (/fail|reject|error|cancel/.test(s)) return "danger";
  if (/pending|confirming|wait|process|claimable/.test(s)) return "warning";
  if (/confirmed|success|approved|paid|claimed|swept|credited|complete|refunded/.test(s)) return "success";

  return "muted";
}

/** Deposit / withdrawal / mixed history rows — UI only. */
export function tierFromHistoryItem(item: {
  type?: string;
  status?: string;
  confirmationStatus?: string;
}): "success" | "warning" | "danger" | "muted" {
  const t = String(item.type || "").toLowerCase();
  const chain = String(item.confirmationStatus || "").toLowerCase();

  if (t.includes("deposit")) {
    if (chain === "confirmed") return "success";
    if (chain === "confirming") return "warning";
    if (chain.includes("fail")) return "danger";
  }

  return resolveStatusTier(String(item.status || ""));
}

export default function StatusBadge({
  children,
  tier,
}: {
  children: ReactNode;
  tier?: "success" | "warning" | "danger" | "muted";
}) {
  const styles = {
    success: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/35",
    warning: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/35",
    danger: "bg-red-500/15 text-red-300 ring-1 ring-red-500/35",
    muted: "bg-white/[0.06] text-gray-400 ring-1 ring-white/10",
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${styles[tier || "muted"]}`}
    >
      {children}
    </span>
  );
}
