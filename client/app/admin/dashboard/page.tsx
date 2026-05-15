"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import { CARD } from "../../../lib/adminTheme";
import { showSafeToast } from "../../../lib/toast";

type OverviewActivity = {
  id: string;
  kind: string;
  at: string;
  action: string;
  username?: string;
  amount?: number;
  txHash?: string;
};

type Overview = {
  totalUsers: number;
  activeUsersDeposit50plus: number;
  totalDepositsUsd: number;
  totalWithdrawalsPaidUsd: number;
  pendingWithdrawalsCount: number;
  totalEarningsPaidUsd: number;
  totalSalaryPaidUsd?: number;
  lastActivities: OverviewActivity[];
};

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={`${CARD} p-5`}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

export default function AdminOverviewDashboardPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
        setError("");
      }
      const payload = await adminFetch("/admin/overview");
      const o = payload?.data?.overview ?? null;
      setOverview(o);
      if (silent) setError("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load overview";
      if (!silent) {
        setError(msg);
        showSafeToast(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => void load(true), 15000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <AdminLayout
      title="Dashboard"
      subtitle="HybridEarn admin overview — auto-refreshes every 15 seconds."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          Live data ·{" "}
          <Link href="/admin/analytics" className="text-purple-300 hover:text-purple-200">
            Open charts & recovery tools
          </Link>
        </p>
        <button
          type="button"
          onClick={() => void load(false)}
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
        >
          Refresh now
        </button>
      </div>

      {loading ? (
        <Loader label="Loading overview…" />
      ) : error ? (
        <div className={`${CARD} border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100`}>
          {error}
        </div>
      ) : overview ? (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              title="Total users"
              value={String(overview.totalUsers ?? 0)}
              hint="All registered accounts"
            />
            <StatCard
              title="Active users"
              value={String(overview.activeUsersDeposit50plus ?? 0)}
              hint="Deposit balance ≥ 50 USDT"
            />
            <StatCard
              title="Total deposits"
              value={formatCurrency(overview.totalDepositsUsd ?? 0)}
              hint="Sum of credited / swept on-chain deposits"
            />
            <StatCard
              title="Total withdrawals (paid)"
              value={formatCurrency(overview.totalWithdrawalsPaidUsd ?? 0)}
              hint="Completed hybrid payouts (net)"
            />
            <StatCard
              title="Pending withdrawals"
              value={String(overview.pendingWithdrawalsCount ?? 0)}
              hint="Awaiting approval or payout"
            />
            <StatCard
              title="Total earnings paid"
              value={formatCurrency(overview.totalEarningsPaidUsd ?? 0)}
              hint={`Paid withdrawals + recorded salary claims${
                overview.totalSalaryPaidUsd != null
                  ? ` · Salary ${formatCurrency(overview.totalSalaryPaidUsd)}`
                  : ""
              }`}
            />
          </div>

          <div className={`${CARD} p-5`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">Last 10 activities</h2>
              <Link href="/admin/logs" className="text-xs font-medium text-purple-300 hover:text-purple-200">
                System logs
              </Link>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Recent deposits, withdrawals, and server-side admin audit events.
            </p>
            <ul className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm">
              {(overview.lastActivities ?? []).length === 0 ? (
                <li className="text-gray-500">No recent activity yet.</li>
              ) : (
                overview.lastActivities.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-gray-200"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                      <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-300">
                        {row.kind}
                      </span>
                      <span>{row.at ? new Date(row.at).toLocaleString() : "—"}</span>
                    </div>
                    <p className="mt-1 font-medium text-white">{row.action}</p>
                    <p className="text-xs text-gray-400">
                      User: {row.username ?? "—"}
                      {row.amount != null ? ` · ${formatCurrency(row.amount)}` : ""}
                    </p>
                    {row.txHash ? (
                      <p className="mt-1 truncate font-mono text-[10px] text-gray-500">{row.txHash}</p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : (
        <div className={`${CARD} p-4 text-sm text-gray-400`}>No overview data.</div>
      )}
    </AdminLayout>
  );
}
