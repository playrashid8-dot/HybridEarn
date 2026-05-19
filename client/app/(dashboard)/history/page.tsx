"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { fetchHybridLedger } from "../../../lib/hybrid";
import ProtectedRoute from "../../../components/ProtectedRoute";
import GlassCard from "../../../components/GlassCard";
import PageSkeleton from "../../../components/Skeleton";
import EmptyState from "../../../components/EmptyState";
import StatusBadge, { resolveStatusTier } from "../../../components/StatusBadge";
import { getMessage } from "../../../lib/vipToast";
import { logout } from "../../../lib/auth";

type LedgerEntry = {
  _id: string;
  createdAt?: string;
  displayType: string;
  typeLabel: string;
  displayAmount: number;
  status: string;
  sourceType?: string;
  financialSourceType?: string;
  detail: string;
};

const TABS: { key: string; label: string; match: (e: LedgerEntry) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "deposit", label: "Deposits", match: (e) => e.displayType === "deposit" },
  { key: "withdraw", label: "Withdrawals", match: (e) => e.displayType === "withdraw" },
  { key: "roi", label: "ROI", match: (e) => e.displayType === "roi" },
  { key: "referral", label: "Team Income", match: (e) => e.displayType === "referral" },
  { key: "first_dep", label: "Team Rewards", match: (e) => e.displayType === "first_deposit_bonus" },
  { key: "salary", label: "Salary", match: (e) => e.displayType === "salary" },
  { key: "admin_credit", label: "Rewards", match: (e) => e.displayType === "admin_credit" },
];

function formatSignedUsd(n: number) {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function badgeTierForLedger(status: string) {
  return resolveStatusTier(String(status || ""));
}

export default function History() {
  const router = useRouter();

  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [activeTab, setActiveTab] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchHybridLedger();
      setEntries(rows as LedgerEntry[]);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        logout("session_expired");
        return;
      }

      setEntries([]);
      setLoadError(getMessage(err, "Unable to load history"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  if (loading) {
    return (
      <ProtectedRoute>
        <div className="w-full px-3 pb-24 pt-2 sm:px-6" aria-busy aria-label="Loading history">
          <PageSkeleton />
        </div>
      </ProtectedRoute>
    );
  }

  if (loadError) {
    return (
      <ProtectedRoute>
        <div className="relative w-full max-w-full overflow-x-hidden pb-24 text-white">
          <div className="flex flex-col gap-3 px-3 pt-2 sm:flex-row sm:items-start sm:justify-between sm:px-6">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-indigo-300/80">
                Ledger
              </p>
              <h1 className="mt-1 bg-gradient-to-r from-white via-indigo-100 to-indigo-300 bg-clip-text text-2xl font-black text-transparent">
                History
              </h1>
            </div>
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="w-full rounded-2xl border border-white/[0.1] bg-[#111827] px-4 py-2.5 text-sm font-semibold text-gray-300 shadow-md transition hover:scale-[1.02] sm:w-auto"
            >
              Back
            </button>
          </div>

          <div className="mt-8 px-3 sm:px-6">
            <div
              role="alert"
              className="rounded-2xl border border-rose-500/35 bg-[#111827]/90 px-6 py-8 text-center ring-1 ring-rose-500/15"
            >
              <p className="text-sm font-semibold text-rose-100">Unable to load history</p>
              <p className="mt-2 text-sm text-gray-400">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadHistory()}
                className="mt-6 min-h-[44px] w-full max-w-[240px] rounded-2xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-3 text-xs font-bold text-emerald-100 transition hover:bg-emerald-500/25 active:scale-[0.98]"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  const tabDef = TABS.find((t) => t.key === activeTab) ?? TABS[0];
  const filtered = entries
    .filter((e) => tabDef.match(e))
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
    );

  return (
    <ProtectedRoute>
      <div className="relative w-full max-w-full overflow-x-hidden pb-24 text-white">
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-indigo-300/80">
              Ledger
            </p>
            <h1 className="mt-1 bg-gradient-to-r from-white via-indigo-100 to-indigo-300 bg-clip-text text-2xl font-black text-transparent">
              History
            </h1>
            <p className="mt-1 max-w-xl text-xs text-gray-400">
              Full account activity from the hybrid ledger: deposits, withdrawals, ROI, team ROI, internal admin
              credits, salary, and more.
            </p>
          </div>

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="w-full rounded-2xl border border-white/[0.1] bg-[#111827] px-4 py-2.5 text-sm font-semibold text-gray-300 shadow-md transition hover:scale-[1.02] sm:w-auto"
          >
            Back
          </button>
        </div>

        <GlassCard glow="purple" className="mt-5 border-[#6366F1]/15">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-8">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-xl px-2 py-2.5 text-[11px] font-semibold transition ${
                  activeTab === tab.key
                    ? "bg-[#6366F1] text-white shadow-[0_0_24px_rgba(99,102,241,0.35)]"
                    : "bg-white/[0.06] text-gray-400 hover:bg-white/[0.09]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </GlassCard>

        <div className="mt-6">
          {filtered.length === 0 && entries.length === 0 ? (
            <EmptyState title="No transactions yet" text="Your hybrid ledger activity will appear here." />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              text={`No ${tabDef.key === "all" ? "" : `${tabDef.label.toLowerCase()} `}transactions in this view`}
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111827]/70 ring-1 ring-white/[0.05]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.07] bg-black/30 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                      <th className="whitespace-nowrap px-4 py-3">Type</th>
                      <th className="whitespace-nowrap px-4 py-3">Amount</th>
                      <th className="whitespace-nowrap px-4 py-3">Details</th>
                      <th className="whitespace-nowrap px-4 py-3">Status</th>
                      <th className="whitespace-nowrap px-4 py-3 text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item, i) => {
                      const amt = Number(item.displayAmount);
                      const tier = badgeTierForLedger(item.status);
                      const amountClass =
                        amt > 0 ? "text-emerald-300" : amt < 0 ? "text-rose-300" : "text-gray-300";

                      return (
                        <motion.tr
                          key={String(item._id || i)}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.35) }}
                          className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.03]"
                        >
                          <td className="px-4 py-3 align-middle">
                            <span className={`text-xs font-bold ${typeAccent(item.displayType)}`}>
                              {item.typeLabel}
                            </span>
                          </td>
                          <td className={`px-4 py-3 align-middle font-semibold tabular-nums ${amountClass}`}>
                            {formatSignedUsd(amt)}
                          </td>
                          <td className="max-w-[240px] px-4 py-3 align-middle text-xs text-gray-400">
                            {item.detail ? (
                              <span className="line-clamp-2">{item.detail}</span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 align-middle">
                            <StatusBadge tier={tier}>{humanStatus(item.status)}</StatusBadge>
                          </td>
                          <td className="px-4 py-3 align-middle text-right text-xs text-gray-400 tabular-nums">
                            {item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}

function typeAccent(displayType: string) {
  switch (displayType) {
    case "deposit":
      return "text-emerald-400";
    case "withdraw":
      return "text-rose-400";
    case "roi":
      return "text-cyan-400";
    case "referral":
      return "text-amber-200";
    case "first_deposit_bonus":
      return "text-lime-300";
    case "salary":
      return "text-violet-300";
    case "admin_credit":
      return "text-emerald-300";
    default:
      return "text-gray-400";
  }
}

function humanStatus(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "credited") return "Credited";
  if (s === "pending") return "Pending";
  if (s === "completed") return "Paid out";
  if (s === "refunded") return "Returned";
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
