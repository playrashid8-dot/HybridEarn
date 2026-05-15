"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import AdminKpiCard from "../../../components/admin/AdminKpiCard";
import AdminLayout, { adminFetch, formatCurrency } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import {
  buildDepositDailySeries,
  buildUserGrowthSeries,
  buildWithdrawDailySeries,
} from "../../../lib/adminChartSeries";
import { getAdminLogs, pushAdminLog } from "../../../lib/adminActivityLog";
import { showSafeToast } from "../../../lib/toast";

const ChartsLazy = dynamic(
  () => import("../../../components/admin/AdminAnalyticsCharts"),
  {
    ssr: false,
    loading: () => (
      <div className="grid gap-4 lg:grid-cols-1 xl:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-[320px] animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    ),
  }
);

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [pendingList, setPendingList] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deepFromBlock, setDeepFromBlock] = useState("");
  const [deepToBlock, setDeepToBlock] = useState("");
  const [recoverTxHash, setRecoverTxHash] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);

  useEffect(() => {
    setLogs(getAdminLogs().slice(0, 8));
  }, []);

  const loadDashboard = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
        setError("");
      }
      const [st, dep, wdr, pend, usr] = await Promise.all([
        adminFetch("/admin/stats"),
        adminFetch("/admin/deposits"),
        adminFetch("/admin/withdrawals"),
        adminFetch("/admin/withdrawals/pending"),
        adminFetch("/admin/users"),
      ]);
      setStats(st?.data?.stats || st?.stats || {});
      setDeposits(dep?.data?.deposits || dep?.deposits || []);
      setWithdrawals(wdr?.data?.withdrawals || wdr?.withdrawals || []);
      setPendingList(pend?.data?.withdrawals || pend?.withdrawals || []);
      setUsers(usr?.data?.users || usr?.users || []);
      if (silent) setError("");
    } catch (err: any) {
      if (!silent) {
        const msg = err?.message || "Failed to load dashboard";
        setError(msg);
        showSafeToast(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard(false);
  }, [loadDashboard]);

  useEffect(() => {
    const id = window.setInterval(() => void loadDashboard(true), 16000);
    return () => clearInterval(id);
  }, [loadDashboard]);

  const pendingPipelineDeposits = useMemo(
    () => deposits.filter((d) => String(d.status).toLowerCase() === "detected").length,
    [deposits]
  );

  const pendingRequests = (pendingList?.length || 0) + pendingPipelineDeposits;

  const depositSeries = useMemo(() => buildDepositDailySeries(deposits, 14), [deposits]);
  const withdrawSeries = useMemo(() => buildWithdrawDailySeries(withdrawals, 14), [withdrawals]);
  const growthSeries = useMemo(() => buildUserGrowthSeries(users, 30), [users]);

  const totalVolumeHint = stats
    ? `Platform balance ${formatCurrency(stats.totalBalance ?? 0)} · Rewards ${formatCurrency(stats.totalEarnings ?? 0)}`
    : "";

  const runRecoverLast = async () => {
    setRecoveryBusy("last");
    try {
      const payload = await adminFetch("/admin/recover-deposits", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const detail = JSON.stringify(payload?.data ?? {});
      pushAdminLog({ action: "Recover last deposits", detail });
      showSafeToast(payload?.msg || "Recover scan completed");
      setLogs(getAdminLogs().slice(0, 8));
    } catch (err: any) {
      pushAdminLog({
        level: "error",
        action: "Recover last deposits",
        detail: err?.message || "Failed",
      });
      showSafeToast(err?.message || "Request failed");
      setLogs(getAdminLogs().slice(0, 8));
    } finally {
      setRecoveryBusy(null);
    }
  };

  const runDeepScan = async () => {
    const fromBlock = Number(deepFromBlock);
    const toBlock = Number(deepToBlock);
    if (
      !Number.isFinite(fromBlock) ||
      !Number.isFinite(toBlock) ||
      fromBlock < 0 ||
      toBlock < 0 ||
      fromBlock > toBlock
    ) {
      showSafeToast("Enter valid From block and To block (from ≤ to)");
      return;
    }
    setRecoveryBusy("deep");
    try {
      const payload = await adminFetch("/admin/rescan-deposits", {
        method: "POST",
        body: JSON.stringify({ fromBlock, toBlock }),
      });
      const detail = JSON.stringify(payload?.data ?? {});
      pushAdminLog({
        action: "Deep scan",
        detail: `${fromBlock}–${toBlock} ${detail}`,
      });
      showSafeToast(payload?.msg || "Deep scan completed");
      setLogs(getAdminLogs().slice(0, 8));
    } catch (err: any) {
      pushAdminLog({
        level: "error",
        action: "Deep scan",
        detail: err?.message || "Failed",
      });
      showSafeToast(err?.message || "Request failed");
      setLogs(getAdminLogs().slice(0, 8));
    } finally {
      setRecoveryBusy(null);
    }
  };

  const runRecoverByTx = async () => {
    const txHash = String(recoverTxHash || "").trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      showSafeToast("Enter a valid transaction hash (0x + 64 hex characters)");
      return;
    }
    setRecoveryBusy("tx");
    try {
      const payload = await adminFetch("/admin/recover-by-tx", {
        method: "POST",
        body: JSON.stringify({ txHash }),
      });
      const detail = JSON.stringify(payload?.data ?? {});
      pushAdminLog({ action: "Recover by TX", detail: `${txHash.slice(0, 12)}… ${detail}` });
      showSafeToast(payload?.msg || "Recover by TX completed");
      setLogs(getAdminLogs().slice(0, 8));
    } catch (err: any) {
      pushAdminLog({
        level: "error",
        action: "Recover by TX",
        detail: err?.message || "Failed",
      });
      showSafeToast(err?.message || "Request failed");
      setLogs(getAdminLogs().slice(0, 8));
    } finally {
      setRecoveryBusy(null);
    }
  };

  return (
    <AdminLayout
      title="Advanced analytics"
      subtitle="Charts, deposit recovery tools, and liquidity — complements the main overview dashboard."
    >
      <p className="mb-6 text-xs text-gray-500">
        <Link href="/admin/dashboard" className="text-purple-300 hover:text-purple-200">
          ← Back to overview dashboard
        </Link>
      </p>
      {loading ? (
        <Loader label="Loading control panel…" />
      ) : error ? (
        <PanelMessage type="error" message={error} />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AdminKpiCard
              variant="violet"
              title="Total users"
              value={stats?.totalUsers ?? 0}
              hint="All registered accounts"
            />
            <AdminKpiCard
              variant="emerald"
              title="Total deposits"
              value={stats?.totalDeposits ?? 0}
              hint="Credited / swept deposit records"
            />
            <AdminKpiCard
              variant="sky"
              title="Total withdrawals"
              value={stats?.totalWithdrawals ?? 0}
              hint="Completed (paid) payouts"
            />
            <AdminKpiCard
              variant="amber"
              title="Pending requests"
              value={pendingRequests}
              hint={`${pendingList?.length || 0} withdrawal row(s) in queue + ${pendingPipelineDeposits} detected deposit(s)`}
            />
          </div>

          <div className="rounded-2xl bg-card p-5 shadow-soft">
            <h3 className="text-sm font-semibold text-white">Deposit recovery</h3>
            <p className="mt-1 text-xs text-gray-500">
              Backup sweep (recent blocks), deep block range scan, or narrow scan around a transaction hash.
            </p>
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={recoveryBusy !== null}
                  onClick={() => void runRecoverLast()}
                  className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  {recoveryBusy === "last" ? "Running…" : "🛟 Recover last deposits"}
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-3 border-t border-white/10 pt-4">
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  From block
                  <input
                    type="text"
                    inputMode="numeric"
                    value={deepFromBlock}
                    onChange={(e) => setDeepFromBlock(e.target.value)}
                    placeholder="e.g. 95317000"
                    className="w-36 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  To block
                  <input
                    type="text"
                    inputMode="numeric"
                    value={deepToBlock}
                    onChange={(e) => setDeepToBlock(e.target.value)}
                    placeholder="e.g. 95323000"
                    className="w-36 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600"
                  />
                </label>
                <button
                  type="button"
                  disabled={recoveryBusy !== null}
                  onClick={() => void runDeepScan()}
                  className="rounded-xl border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50"
                >
                  {recoveryBusy === "deep" ? "Scanning…" : "🔎 Deep scan"}
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-3 border-t border-white/10 pt-4">
                <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-xs text-gray-400">
                  Transaction hash
                  <input
                    type="text"
                    value={recoverTxHash}
                    onChange={(e) => setRecoverTxHash(e.target.value.trim())}
                    placeholder="0x…"
                    className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-sm text-white placeholder:text-gray-600"
                  />
                </label>
                <button
                  type="button"
                  disabled={recoveryBusy !== null}
                  onClick={() => void runRecoverByTx()}
                  className="rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
                >
                  {recoveryBusy === "tx" ? "Recovering…" : "⚡ Recover by TX"}
                </button>
              </div>
            </div>
          </div>

          <ChartsLazy
            depositSeries={depositSeries}
            withdrawSeries={withdrawSeries}
            growthSeries={growthSeries}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-card p-5 shadow-soft">
              <h3 className="text-sm font-semibold text-white">Liquidity snapshot</h3>
              <p className="mt-1 text-xs text-gray-500">{totalVolumeHint}</p>
              <dl className="mt-4 grid gap-3 text-sm">
                <div className="flex justify-between gap-2 border-b border-white/5 pb-2">
                  <dt className="text-gray-400">Total balance (users)</dt>
                  <dd className="font-medium text-emerald-300 tabular-nums">
                    {formatCurrency(stats?.totalBalance ?? 0)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-b border-white/5 pb-2">
                  <dt className="text-gray-400">Total earnings (users)</dt>
                  <dd className="font-medium text-sky-300 tabular-nums">
                    {formatCurrency(stats?.totalEarnings ?? 0)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl bg-card p-5 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">Recent activity</h3>
                <Link
                  href="/admin/logs"
                  className="text-xs font-medium text-purple-300 hover:text-purple-200"
                >
                  View all
                </Link>
              </div>
              <p className="mt-1 text-xs text-gray-500">Local log of admin clicks & API results on this browser</p>
              <ul className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1 text-sm">
                {logs.length === 0 ? (
                  <li className="text-gray-500">No entries yet — actions will appear here.</li>
                ) : (
                  logs.map((row) => (
                    <li
                      key={row.id}
                      className={`rounded-lg border px-3 py-2 ${
                        row.level === "error"
                          ? "border-red-500/25 bg-red-500/5 text-red-100"
                          : "border-white/10 bg-black/20 text-gray-200"
                      }`}
                    >
                      <span className="text-xs text-gray-500">
                        {new Date(row.ts).toLocaleString()}
                      </span>
                      <div className="font-medium">{row.action}</div>
                      {row.detail ? <div className="text-xs text-gray-400">{row.detail}</div> : null}
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function PanelMessage({ type = "info", message }: { type?: string; message: string }) {
  const styles =
    type === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-100"
      : "border-white/10 bg-white/[0.04] text-gray-300";

  return <div className={`rounded-2xl border p-4 text-sm ${styles}`}>{message}</div>;
}
