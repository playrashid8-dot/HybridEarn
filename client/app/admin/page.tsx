"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency, getUserLabel } from "../../components/admin/AdminLayout";
import Loader from "../../components/admin/Loader";
import {
  depositStatusClasses,
  withdrawalStatusClasses,
} from "../../components/admin/adminStatusClasses";
import { showSafeToast } from "../../lib/toast";

type DepositRow = {
  txHash: string;
  wallet: string;
  amount: number;
  status: string;
  createdAt: string;
};

type UserSummary = {
  _id: string;
  username: string;
  wallet: string;
  depositBalance: number;
  totalEarned: number;
  vipLevel: number;
};

export default function AdminControlPanelPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deposits, setDeposits] = useState<DepositRow[]>([]);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState<string | null>(null);
  const [vipBusy, setVipBusy] = useState(false);
  const [vipUserId, setVipUserId] = useState("");
  const [vipLevelInput, setVipLevelInput] = useState("0");

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const [dep, wdr, usr] = await Promise.all([
        adminFetch("/admin/deposits"),
        adminFetch("/admin/withdrawals"),
        adminFetch("/admin/users"),
      ]);
      const latest =
        dep?.data?.latestDeposits ||
        dep?.latestDeposits ||
        dep?.data?.deposits ||
        dep?.deposits ||
        [];
      const mapped: DepositRow[] = (latest as any[]).map((d) => ({
        txHash: d.txHash,
        wallet: d.wallet ?? d.walletAddress ?? "",
        amount: d.amount,
        status: d.status,
        createdAt: d.createdAt,
      }));
      setDeposits(mapped.slice(0, 50));
      setWithdrawals(wdr?.data?.withdrawals || wdr?.withdrawals || []);
      const summaries =
        usr?.data?.userSummaries ||
        usr?.userSummaries ||
        (usr?.data?.users || usr?.users || []).map((u: any) => ({
          _id: u._id,
          username: u.username,
          wallet: u.walletAddress,
          depositBalance: u.depositBalance,
          totalEarned: u.totalEarnings,
          vipLevel: u.vipLevel,
        }));
      setUsers((summaries as UserSummary[]).slice(0, 100));
      if (silent) setError("");
    } catch (err: any) {
      const msg = err?.message || "Failed to load admin data";
      if (!silent) {
        setError(msg);
        showSafeToast(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  useEffect(() => {
    const id = window.setInterval(() => void loadAll(true), 16000);
    return () => clearInterval(id);
  }, [loadAll]);

  const recoverDeposits = async () => {
    setRecoverBusy(true);
    try {
      await adminFetch("/admin/recover-deposits", { method: "POST", body: JSON.stringify({}) });
      showSafeToast("Recovery scan started");
      await loadAll();
    } catch (err: any) {
      showSafeToast(err?.message || "Recovery failed");
    } finally {
      setRecoverBusy(false);
    }
  };

  const actWithdraw = async (id: string, action: "approve" | "reject") => {
    setWithdrawBusy(`${action}:${id}`);
    try {
      await adminFetch(`/admin/withdraw/${action}/${id}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showSafeToast(action === "approve" ? "Withdrawal approved" : "Withdrawal rejected");
      await loadAll();
    } catch (err: any) {
      showSafeToast(err?.message || "Withdrawal action failed");
    } finally {
      setWithdrawBusy(null);
    }
  };

  const saveVip = async () => {
    if (!vipUserId) {
      showSafeToast("Select a user");
      return;
    }
    const vipLevel = Number(vipLevelInput);
    if (!Number.isFinite(vipLevel) || vipLevel < 0) {
      showSafeToast("VIP level must be a non-negative number");
      return;
    }
    setVipBusy(true);
    try {
      await adminFetch("/admin/set-vip", {
        method: "POST",
        body: JSON.stringify({ userId: vipUserId, vipLevel }),
      });
      showSafeToast("VIP updated");
      setVipLevelInput("0");
      await loadAll();
    } catch (err: any) {
      showSafeToast(err?.message || "VIP update failed");
    } finally {
      setVipBusy(false);
    }
  };

  const pendingWithdrawals = withdrawals.filter((w) =>
    ["pending", "claimable", "approved"].includes(String(w.status || "").toLowerCase())
  );

  return (
    <AdminLayout
      title="Admin control panel"
      subtitle="System health, deposit recovery, withdrawals, users, and VIP — one place."
    >
      {loading ? (
        <Loader label="Loading control panel…" />
      ) : error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
          {error}
        </div>
      ) : (
        <div className="space-y-8">
          <p className="text-xs text-gray-500">
            <Link href="/admin/dashboard" className="text-purple-300 hover:text-purple-200">
              Open overview dashboard →
            </Link>
          </p>
          <section className="rounded-2xl bg-card p-5 shadow-soft">
            <h2 className="text-sm font-semibold text-white">Recovery</h2>
            <p className="mt-1 text-xs text-gray-500">
              Runs a duplicate-safe scan over the latest 1000 confirmed blocks to pick up missed USDT deposits.
            </p>
            <button
              type="button"
              disabled={recoverBusy}
              onClick={() => void recoverDeposits()}
              className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {recoverBusy ? "Running…" : "🛟 Recover deposits"}
            </button>
          </section>

          <section className="rounded-2xl bg-card p-5 shadow-soft">
            <h2 className="text-sm font-semibold text-white">Latest deposits</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm text-gray-200">
                <thead className="border-b border-white/10 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="pb-2 pr-4">Tx hash</th>
                    <th className="pb-2 pr-4">Wallet</th>
                    <th className="pb-2 pr-4">Amount</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {deposits.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-gray-500">
                        No deposits yet.
                      </td>
                    </tr>
                  ) : (
                    deposits.map((d) => (
                      <tr key={d.txHash} className="align-top">
                        <td className="py-2 pr-4 font-mono text-xs text-gray-400">{d.txHash}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-gray-400">{d.wallet}</td>
                        <td className="py-2 pr-4 tabular-nums">{formatCurrency(d.amount)}</td>
                        <td className="py-2">
                          <span className={`rounded-md px-2 py-0.5 text-xs ${depositStatusClasses(d.status)}`}>
                            {d.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl bg-card p-5 shadow-soft">
            <h2 className="text-sm font-semibold text-white">Withdrawals (queue)</h2>
            <p className="mt-1 text-xs text-gray-500">Approve or reject hybrid withdrawal requests (status-only updates on the record).</p>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm text-gray-200">
                <thead className="border-b border-white/10 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="pb-2 pr-4">User</th>
                    <th className="pb-2 pr-4">Amount</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {pendingWithdrawals.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-gray-500">
                        No pending withdrawals in this queue snapshot.
                      </td>
                    </tr>
                  ) : (
                    pendingWithdrawals.slice(0, 25).map((w) => {
                      const id = w._id;
                      return (
                        <tr key={id} className="align-top">
                          <td className="py-2 pr-4">{getUserLabel(w.userId)}</td>
                          <td className="py-2 pr-4 tabular-nums">{formatCurrency(w.netAmount ?? w.amount ?? 0)}</td>
                          <td className="py-2 pr-4">
                            <span className={`rounded-md px-2 py-0.5 text-xs ${withdrawalStatusClasses(w.status)}`}>
                              {w.status}
                            </span>
                          </td>
                          <td className="py-2">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={withdrawBusy !== null}
                                onClick={() => void actWithdraw(id, "approve")}
                                className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-xs text-emerald-100 disabled:opacity-50"
                              >
                                ✔️ Approve
                              </button>
                              <button
                                type="button"
                                disabled={withdrawBusy !== null}
                                onClick={() => void actWithdraw(id, "reject")}
                                className="rounded-lg border border-red-500/40 bg-red-500/15 px-2 py-1 text-xs text-red-100 disabled:opacity-50"
                              >
                                ❌ Reject
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl bg-card p-5 shadow-soft">
            <h2 className="text-sm font-semibold text-white">Users</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm text-gray-200">
                <thead className="border-b border-white/10 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="pb-2 pr-4">Username</th>
                    <th className="pb-2 pr-4">Wallet</th>
                    <th className="pb-2 pr-4">Balance</th>
                    <th className="pb-2">VIP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {users.map((u) => (
                    <tr key={u._id}>
                      <td className="py-2 pr-4">{u.username}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-gray-400">{u.wallet || "—"}</td>
                      <td className="py-2 pr-4 tabular-nums">{formatCurrency(u.depositBalance ?? 0)}</td>
                      <td className="py-2 tabular-nums">{u.vipLevel ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl bg-card p-5 shadow-soft">
            <h2 className="text-sm font-semibold text-white">VIP control</h2>
            <p className="mt-1 text-xs text-gray-500">Set VIP level for a user (updates vipLevel only).</p>
            <div className="mt-4 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1 text-xs text-gray-400">
                User
                <select
                  value={vipUserId}
                  onChange={(e) => setVipUserId(e.target.value)}
                  className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                >
                  <option value="">Select user…</option>
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.username} (VIP {u.vipLevel ?? 0})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex w-36 flex-col gap-1 text-xs text-gray-400">
                VIP level
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={vipLevelInput}
                  onChange={(e) => setVipLevelInput(e.target.value)}
                  className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </label>
              <button
                type="button"
                disabled={vipBusy}
                onClick={() => void saveVip()}
                className="rounded-xl border border-purple-500/40 bg-purple-500/15 px-4 py-2 text-sm font-medium text-purple-100 hover:bg-purple-500/25 disabled:opacity-50"
              >
                {vipBusy ? "Saving…" : "Apply VIP"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AdminLayout>
  );
}
