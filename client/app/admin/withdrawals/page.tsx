"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency, formatDate, getUserLabel } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import AdminPagination from "../../../components/admin/AdminPagination";
import ConfirmModal from "../../../components/admin/ConfirmModal";
import { withdrawalStatusClasses } from "../../../components/admin/adminStatusClasses";
import { pushAdminLog } from "../../../lib/adminActivityLog";
import EmptyState from "../../../components/EmptyState";
import { showAdminToast, showSafeToast } from "../../../lib/toast";
import { getApiErrorMessage } from "../../../lib/api";

const PAGE_SIZE = 25;
const ROW_CAP = 200;


const WITHDRAWAL_STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  approved: "approved",
  processing: "processing",
  paid: "paid",
  failed: "failed",
  review: "under review",
  claimable: "claimable",
  completed: "completed",
  claimed: "completed",
  rejected: "rejected",
};

function displayWithdrawalStatus(status: unknown): string {
  const key = String(status ?? "").trim().toLowerCase();
  if (!key) return "unknown";
  return WITHDRAWAL_STATUS_LABEL[key] || key.replace(/-/g, " ");
}

/** Server-computed heuristic; mirrors backend thresholds and console alerts. */
function withdrawalRiskBadge(riskScore: unknown): { label: string; className: string } {
  const n = Number(riskScore ?? 0);
  if (!Number.isFinite(n)) {
    return { label: "Safe", className: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30" };
  }
  if (n >= 4) {
    return { label: "🚨 HIGH RISK", className: "bg-red-500/20 text-red-100 ring-1 ring-red-500/40" };
  }
  if (n >= 2) {
    return { label: "⚠️ Medium", className: "bg-amber-500/15 text-amber-100 ring-1 ring-amber-500/35" };
  }
  return { label: "Safe", className: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30" };
}

function withdrawalErrorMessage(err: unknown): string {
  const base = getApiErrorMessage(err, "");
  const msg = typeof base === "string" && base ? base : "";
  const fromErr =
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "";
  const resolved = msg || fromErr || "Something went wrong";
  if (/csrf|forbidden/i.test(resolved)) {
    return `${resolved}. If this persists after a retry, reload the admin page (session or CSRF was refreshed automatically).`;
  }
  return resolved;
}

export default function AdminWithdrawalsPage() {
  const [listMode, setListMode] = useState<"queue" | "all">("queue");
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [processingId, setProcessingId] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<null | { kind: "approve" | "reject" | "force"; row: any }>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmActionLoading, setConfirmActionLoading] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [rejectAllBusy, setRejectAllBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const loadWithdrawals = useCallback(
    async (silent = false) => {
      try {
        if (!silent) {
          setLoading(true);
          setError("");
        }
        const path = listMode === "queue" ? "/admin/withdrawals/pending" : "/admin/withdrawals";
        const payload = await adminFetch(path);
        setWithdrawals(payload?.data?.withdrawals || payload?.withdrawals || []);
        if (silent) setError("");
      } catch (err: any) {
        const msg = withdrawalErrorMessage(err);
        if (!silent) {
          setError(msg);
          showSafeToast(msg);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [listMode]
  );

  useEffect(() => {
    void loadWithdrawals(false);
  }, [loadWithdrawals]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadWithdrawals(true);
    }, 12000);
    return () => clearInterval(id);
  }, [loadWithdrawals]);

  const statusSummary = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let completed = 0;
    let processing = 0;
    for (const w of withdrawals) {
      const s = String(w.status || "").toLowerCase();
      if (s === "pending" || s === "claimable" || s === "review") pending += 1;
      else if (s === "approved") approved += 1;
      else if (s === "paid" || s === "claimed") completed += 1;
      else if (s === "processing") processing += 1;
    }
    return { pending, approved, completed, processing, total: withdrawals.length };
  }, [withdrawals]);

  const safeWithdrawals = useMemo(() => withdrawals.slice(0, ROW_CAP), [withdrawals]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return safeWithdrawals.filter((w) => {
      const st = String(w.status || "").toLowerCase();
      const okStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "completed"
            ? st === "paid" || st === "claimed"
            : st === statusFilter;
      const u = w.userId;
      const label = getUserLabel(u).toLowerCase();
      const email = (u?.email || "").toLowerCase();
      const wallet = (w.walletAddress || "").toLowerCase();
      const okSearch = !q || label.includes(q) || email.includes(q) || wallet.includes(q);
      return okStatus && okSearch;
    });
  }, [safeWithdrawals, debouncedSearch, statusFilter]);

  const sortedFiltered = useMemo(() => {
    const rank = (p: unknown) => (String(p ?? "normal") === "high" ? 0 : 1);
    return [...filtered].sort((a, b) => {
      const pr = rank(a.priority) - rank(b.priority);
      if (pr !== 0) return pr;
      const ra = Number(a.riskScore ?? 0);
      const rb = Number(b.riskScore ?? 0);
      if (rb !== ra) return rb - ra;
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta;
    });
  }, [filtered]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, listMode, withdrawals.length]);

  const total = sortedFiltered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = sortedFiltered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const execConfirmed = async () => {
    if (!confirm || confirmActionLoading) return;
    const { kind, row } = confirm;
    const idRaw = row._id;
    const id = idRaw != null ? encodeURIComponent(String(idRaw)) : "";
    if (!id || processingId) return;

    try {
      setConfirmActionLoading(true);
      setProcessingId(`${kind}:${id}`);
      setMessage("");
      setError("");

      if (kind === "approve") {
        await adminFetch("/admin/hybrid/withdraw/approve", {
          method: "POST",
          body: JSON.stringify({ withdrawalId: idRaw }),
        });
        setMessage("Withdrawal approved");
        pushAdminLog({ action: "Withdrawal approved", detail: getUserLabel(row.userId) });
      } else if (kind === "force") {
        await adminFetch(`/admin/hybrid/withdraw/force/${id}`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setMessage("Force payout completed — USDT sent on-chain");
        pushAdminLog({ action: "Force hybrid payout", detail: getUserLabel(row.userId) });
      } else if (kind === "reject") {
        await adminFetch("/admin/hybrid/withdraw/reject", {
          method: "POST",
          body: JSON.stringify({ withdrawalId: idRaw }),
        });
        setMessage("Withdrawal rejected and refunded");
        pushAdminLog({ action: "Withdrawal rejected", detail: getUserLabel(row.userId) });
      }

      setConfirm(null);
      await loadWithdrawals(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("nova-admin-refresh-status"));
      }
    } catch (err: any) {
      const msg = withdrawalErrorMessage(err);
      setError(msg);
      showSafeToast(msg);
      pushAdminLog({
        level: "error",
        action: `Withdrawal ${kind} failed`,
        detail: msg,
      });
      setConfirm(null);
    } finally {
      setProcessingId("");
      setConfirmActionLoading(false);
    }
  };

  const handleRejectAll = async () => {
    const confirmed = window.confirm(
      "Reject ALL eligible unpaid withdrawals (pending, review, claimable, approved-but-unpaid)? Paid and in-flight payouts are skipped. This cannot be undone."
    );
    if (!confirmed || rejectAllBusy || Boolean(processingId)) return;

    try {
      setRejectAllBusy(true);
      setMessage("");
      setError("");
      const payload = await adminFetch("/admin/hybrid/withdraw/reject-all", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const total = Number(payload?.data?.totalRejected ?? 0);
      const line = `Rejected ${Number.isFinite(total) ? total : 0} withdrawal(s).`;
      setMessage(line);
      showSafeToast(line);
      pushAdminLog({ action: "Bulk reject withdrawals", detail: line });
      await loadWithdrawals(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("nova-admin-refresh-status"));
      }
    } catch (err: unknown) {
      const msg = withdrawalErrorMessage(err);
      setError(msg);
      showSafeToast(msg);
      pushAdminLog({ level: "error", action: "Bulk reject withdrawals failed", detail: msg });
    } finally {
      setRejectAllBusy(false);
    }
  };

  const confirmMessage = () => {
    if (!confirm) return "";
    const who = getUserLabel(confirm.row.userId);
    if (confirm.kind === "force")
      return `Force immediate payout for ${who}? This approves if needed, sends net USDT from the treasury wallet now, and marks the withdrawal paid after confirmation.`;
    if (confirm.kind === "approve")
      return `Approve withdrawal for ${who}? Ensure the user completed any required wait period.`;
    return `Reject and refund withdrawal for ${who}? This will release pending funds back per system rules.`;
  };

  return (
    <AdminLayout
      title="Withdrawal management"
      subtitle="Queue pending work, approve, force payout through the executor, or reject — all CSRF-safe with automatic retry."
    >
      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-1">
            <button
              type="button"
              onClick={() => setListMode("queue")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                listMode === "queue" ? "bg-purple-600 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              Pending queue
            </button>
            <button
              type="button"
              onClick={() => setListMode("all")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                listMode === "all" ? "bg-purple-600 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              All withdrawals
            </button>
          </div>
          <button
            type="button"
            disabled={refreshBusy || Boolean(processingId) || loading || rejectAllBusy}
            onClick={async () => {
              setRefreshBusy(true);
              try {
                await loadWithdrawals(true);
              } finally {
                setRefreshBusy(false);
              }
            }}
            className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-medium text-gray-100 transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshBusy ? "Refreshing…" : "Refresh list"}
          </button>
          <button
            type="button"
            disabled={refreshBusy || Boolean(processingId) || loading || rejectAllBusy}
            onClick={() => void handleRejectAll()}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rejectAllBusy ? "Rejecting…" : "🔥 Reject all withdrawals"}
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user, email, or wallet"
            className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-purple-500"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-xl border border-white/10 bg-[#0b0b0f] px-4 py-3 text-sm text-white outline-none sm:w-48"
          >
            <option value="all">All statuses</option>
            <option value="review">Under review</option>
            <option value="pending">pending</option>
            <option value="claimable">Claimable</option>
            <option value="approved">approved</option>
            <option value="processing">processing</option>
            <option value="completed">Completed</option>
            <option value="paid">paid</option>
            <option value="failed">failed</option>
            <option value="rejected">Rejected</option>
            <option value="claimed">Claimed</option>
          </select>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber-400/90" aria-hidden />
          <span className="text-gray-400">Pending / claimable</span>
          <span className="font-semibold tabular-nums text-white">{statusSummary.pending}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-sky-400/90" aria-hidden />
          <span className="text-gray-400">approved</span>
          <span className="font-semibold tabular-nums text-white">{statusSummary.approved}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-indigo-400/90" aria-hidden />
          <span className="text-gray-400">processing</span>
          <span className="font-semibold tabular-nums text-white">{statusSummary.processing}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400/90" aria-hidden />
          <span className="text-gray-400">paid / completed</span>
          <span className="font-semibold tabular-nums text-white">{statusSummary.completed}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-gray-500">
          <span>Loaded</span>
          <span className="font-semibold tabular-nums text-gray-300">{statusSummary.total}</span>
        </div>
      </div>

      <StatusMessage message={message} />
      <StatusMessage type="error" message={error} />

      {loading ? (
        <Loader label="Loading withdrawals…" />
      ) : !error && !withdrawals.length ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={["User", "Gross", "Net", "Wallet", "Status", "Risk", "Time", "Actions"]}
          emptyText={listMode === "queue" ? "No rows in the pending queue" : "No withdrawals match filters"}
          footer={
            <AdminPagination page={safePage} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          }
        >
          {slice.map((withdrawal) => {
            const st = String(withdrawal.status || "").toLowerCase();
            const queueStatuses = new Set(["pending", "claimable", "review"]);
            const unpaid =
              !withdrawal.paidAt && st !== "paid" && st !== "rejected" && st !== "claimed";
            const canApprove = queueStatuses.has(st);
            const canReject =
              queueStatuses.has(st) ||
              (st === "approved" && unpaid);
            const approving = processingId === `approve:${encodeURIComponent(String(withdrawal._id))}`;
            const forcing = processingId === `force:${encodeURIComponent(String(withdrawal._id))}`;
            const rejecting = processingId === `reject:${encodeURIComponent(String(withdrawal._id))}`;
            const canForcePayout = unpaid && (queueStatuses.has(st) || st === "approved");
            const badgeCls = withdrawalStatusClasses(st);
            const riskTier = withdrawalRiskBadge(withdrawal.riskScore);

            return (
              <tr key={withdrawal._id} className="hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-4 py-4">
                  <div className="font-medium text-white">{getUserLabel(withdrawal.userId)}</div>
                  {withdrawal.userId?.email ? (
                    <div className="text-xs text-gray-500">{withdrawal.userId.email}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-emerald-300 tabular-nums">
                  {formatCurrency(withdrawal.grossAmount)}
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-sky-200 tabular-nums">
                  {formatCurrency(withdrawal.netAmount)}
                </td>
                <td className="min-w-0 max-w-[min(100vw-3rem,26rem)] px-4 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-xs leading-relaxed text-gray-300 break-all">
                        {withdrawal.walletAddress || "—"}
                      </span>
                    </div>
                    {withdrawal.walletAddress ? (
                      <button
                        type="button"
                        onClick={async () => {
                          const w = String(withdrawal.walletAddress || "");
                          try {
                            await navigator.clipboard.writeText(w);
                            showAdminToast("Address copied", "success");
                          } catch {
                            showAdminToast("Could not copy address", "error");
                          }
                        }}
                        className="h-fit shrink-0 self-start rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200 shadow-sm shadow-sky-950/20 transition hover:border-sky-400/50 hover:bg-sky-500/20 active:scale-[0.98]"
                      >
                        Copy
                      </button>
                    ) : null}
                  </div>
                  {withdrawal.txHash ? (
                    <span className="mt-2 block break-all font-mono text-[10px] text-gray-500">
                      tx: {withdrawal.txHash}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-4">
                  <span className={`inline-flex rounded-full px-3 py-1 text-xs ${badgeCls}`}>
                    {displayWithdrawalStatus(withdrawal.status)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-4">
                  <div className="flex flex-col gap-1">
                    <span
                      className={`inline-flex w-fit max-w-[180px] rounded-lg px-2.5 py-1 text-[11px] font-semibold leading-tight ${riskTier.className}`}
                    >
                      {riskTier.label}
                    </span>
                    {(withdrawal.priority ?? "normal") === "high" ? (
                      <span className="text-[10px] font-medium text-fuchsia-200/95">Priority: high</span>
                    ) : null}
                    <span className="tabular-nums text-[10px] text-gray-500">
                      Score: {Number(withdrawal.riskScore ?? 0)}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-xs text-gray-400">{formatDate(withdrawal.createdAt)}</td>
                <td className="min-w-[220px] px-4 py-4">
                  <div className="flex flex-col gap-2">
                    {canForcePayout ? (
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: "force", row: withdrawal })}
                        disabled={Boolean(processingId) || confirmActionLoading}
                        className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white shadow shadow-orange-900/30 hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {forcing ? "Forcing…" : "⚡ Force Payout"}
                      </button>
                    ) : null}
                    {canApprove ? (
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: "approve", row: withdrawal })}
                        disabled={Boolean(processingId) || confirmActionLoading}
                        className="rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {approving ? "Approving…" : "✅ Approve"}
                      </button>
                    ) : null}
                    {canReject ? (
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: "reject", row: withdrawal })}
                        disabled={Boolean(processingId) || confirmActionLoading}
                        className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {rejecting ? "Rejecting…" : "❌ Reject & refund"}
                      </button>
                    ) : null}
                    {!canApprove && !canReject && !canForcePayout ? (
                      <span className="text-xs text-gray-500">No actions</span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <ConfirmModal
        open={Boolean(confirm)}
        title="Are you sure?"
        message={confirmMessage()}
        confirmLabel={
          confirm?.kind === "approve"
            ? "Yes, approve"
            : confirm?.kind === "force"
              ? "Yes, force payout"
              : "Yes, reject"
        }
        cancelLabel="Cancel"
        danger={confirm?.kind === "reject" || confirm?.kind === "force"}
        confirmLoading={confirmActionLoading}
        onCancel={() => !confirmActionLoading && setConfirm(null)}
        onConfirm={execConfirmed}
      >
        {null}
      </ConfirmModal>

      <p className="mt-6 text-[11px] leading-relaxed text-gray-500">
        Payouts are completed by the on-chain executor after approval — manual “mark paid” is disabled server-side for safety. Live list polls every ~12 seconds while this tab is visible; use Refresh for an immediate reload.
      </p>
    </AdminLayout>
  );
}

function StatusMessage({ type = "success", message }: { type?: string; message: string }) {
  if (!message) return null;

  const styles =
    type === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-100"
      : "border-green-500/20 bg-green-500/10 text-green-100";

  return <div className={`mb-4 rounded-xl border p-3 text-sm ${styles}`}>{message}</div>;
}
