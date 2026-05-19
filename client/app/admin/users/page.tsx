"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminLayout, {
  adminFetch,
  formatCurrency,
  formatDate,
  getUserLabel,
} from "../../../components/admin/AdminLayout";
import Table from "../../../components/admin/Table";
import AdminPagination from "../../../components/admin/AdminPagination";
import ConfirmModal from "../../../components/admin/ConfirmModal";
import { CARD } from "../../../lib/adminTheme";
import { pushAdminLog } from "../../../lib/adminActivityLog";
import EmptyState from "../../../components/EmptyState";
import { showAdminToast, showSafeToast } from "../../../lib/toast";

const PAGE_SIZE = 25;
const ROW_CAP = 2000;
const CREDIT_CATEGORIES = [
  { value: "cashback", label: "Cashback" },
  { value: "compensation", label: "Compensation" },
  { value: "promotion", label: "Promotion" },
  { value: "recovery", label: "Recovery" },
  { value: "referral_bonus", label: "Referral bonus" },
  { value: "marketing_reward", label: "Marketing reward" },
];
const CREDIT_ACTIONS = [
  { key: "add_reward", label: "Add Reward", category: "marketing_reward" },
  { key: "add_bonus", label: "Add Bonus", category: "referral_bonus" },
  { key: "promotional_credit", label: "Promotional Credit", category: "promotion" },
  { key: "compensation_credit", label: "Compensation Credit", category: "compensation" },
  { key: "cashback_credit", label: "Cashback Credit", category: "cashback" },
  { key: "recovery_credit", label: "Recovery Credit", category: "recovery" },
];
const USER_FILTERS = [
  { value: "highest_available", label: "Highest available" },
  { value: "pending_withdrawals", label: "Pending withdrawals" },
  { value: "blocked", label: "Blocked users" },
  { value: "admin_users", label: "Admin users" },
  { value: "newest", label: "Newest users" },
  { value: "admin_rewards", label: "Admin rewards" },
  { value: "active_earnings", label: "Active earnings" },
];
const DEFAULT_POLL_MS = 15000;

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `admin-credit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [financeFilter, setFinanceFilter] = useState("highest_available");
  const [minAvailable, setMinAvailable] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS);
  const [lastUpdated, setLastUpdated] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [processingId, setProcessingId] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "block" | "unblock"; user: any }>(
    null
  );
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmActionLoading, setConfirmActionLoading] = useState(false);
  const [fraudConfirm, setFraudConfirm] = useState<null | "flag" | "unflag">(null);
  const [fraudReason, setFraudReason] = useState("");
  const [fraudActionLoading, setFraudActionLoading] = useState(false);
  const [detail, setDetail] = useState<null | { user: any; directTeam: any[]; stats?: any }>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [teamOnly, setTeamOnly] = useState<null | { user: any; directTeam: any[] }>(null);
  const [creditModal, setCreditModal] = useState<null | { user: any; action: any }>(null);
  const [creditConfirm, setCreditConfirm] = useState(false);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditForm, setCreditForm] = useState({
    amount: "",
    reason: "",
    category: "marketing_reward",
    internalAdminNote: "",
  });
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const loadUsers = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      try {
        if (silent) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        setError("");
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_SIZE),
          filter: financeFilter,
        });
        if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
        const min = Number(minAvailable);
        if (Number.isFinite(min) && min > 0) params.set("minAvailable", String(min));

        const payload = await adminFetch(`/admin/users?${params.toString()}`);
        if (requestSeq.current !== seq) return;
        const data = payload?.data || {};
        setUsers((data.users || payload?.users || []).slice(0, ROW_CAP));
        setTotal(Number(data.total || 0));
        setSummary(data.summary || null);
        setPollMs(Number(data.pollingMs || DEFAULT_POLL_MS));
        setLastUpdated(data.updatedAt || new Date().toISOString());
      } catch (err: any) {
        if (requestSeq.current === seq) {
          const msg = err?.message || "Failed to load users";
          setError(msg);
          if (!silent) showSafeToast(msg);
        }
      } finally {
        if (requestSeq.current === seq) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [debouncedSearch, financeFilter, minAvailable, page]
  );

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadUsers({ silent: true });
    }, Math.max(pollMs, 10000));
    return () => window.clearInterval(interval);
  }, [loadUsers, pollMs]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = users;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const openDetails = async (user: any) => {
    const id = user._id;
    if (!id) return;
    setDetailLoading(true);
    setDetail(null);
    try {
      const payload = await adminFetch(`/admin/users/${id}/detail`);
      const d = payload?.data;
      setDetail({ user: d?.user, directTeam: d?.directTeam || [], stats: d?.stats });
    } catch (e: any) {
      showSafeToast(e?.message || "Failed to load user");
    } finally {
      setDetailLoading(false);
    }
  };

  const openTeam = async (user: any) => {
    const id = user._id;
    if (!id) return;
    setDetailLoading(true);
    setTeamOnly(null);
    try {
      const payload = await adminFetch(`/admin/users/${id}/detail`);
      const d = payload?.data;
      setTeamOnly({ user: d?.user, directTeam: d?.directTeam || [] });
    } catch (e: any) {
      showSafeToast(e?.message || "Failed to load team");
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshUserInList = (id: string, patch: Record<string, unknown>) => {
    setUsers((prev) =>
      prev.map((u) => (String(u._id) === String(id) ? { ...u, ...patch } : u))
    );
  };

  const openCreditModal = (user: any, action = CREDIT_ACTIONS[0]) => {
    if (!user?._id || user.isBlocked || user.adminFraudFlag) {
      showAdminToast("Financial credits are blocked for inactive or fraud-flagged users", "warning");
      return;
    }
    setCreditModal({ user, action });
    setCreditForm({
      amount: "",
      reason: "",
      category: action.category,
      internalAdminNote: "",
    });
    setCreditConfirm(false);
  };

  const requestCreditConfirmation = () => {
    if (!creditModal || creditLoading) return;
    const amount = Number(creditForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      showAdminToast("Amount must be greater than 0", "error");
      return;
    }
    if (!creditForm.reason.trim()) {
      showAdminToast("Reason is required", "error");
      return;
    }
    setCreditConfirm(true);
  };

  const runFinancialCredit = async () => {
    if (!creditModal?.user?._id || creditLoading) return;
    const id = String(creditModal.user._id);
    const idempotencyKey = createIdempotencyKey();
    try {
      setCreditLoading(true);
      setError("");
      const payload = await adminFetch(`/admin/users/${id}/financial-credit`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          actionType: creditModal.action.key,
          amount: Number(creditForm.amount),
          reason: creditForm.reason.trim(),
          category: creditForm.category,
          internalAdminNote: creditForm.internalAdminNote.trim(),
        }),
      });
      const updated = payload?.data?.user;
      if (updated?._id) {
        refreshUserInList(String(updated._id), {
          balance: updated.balance,
          depositBalance: updated.depositBalance,
          rewardBalance: updated.rewardBalance,
          availableUSDT: Number(updated.depositBalance || 0) + Number(updated.rewardBalance || 0),
          totalEarnings: updated.totalEarnings,
        });
        if (detail?.user?._id && String(detail.user._id) === String(updated._id)) {
          setDetail((prev) => (prev ? { ...prev, user: { ...prev.user, ...updated } } : prev));
        }
      }
      const newAvailable = payload?.data?.credit?.newAvailableUSDT;
      showAdminToast(
        Number.isFinite(Number(newAvailable))
          ? `Internal admin credit applied. Available USDT: ${formatCurrency(newAvailable)}`
          : "Internal admin credit applied",
        "success"
      );
      pushAdminLog({
        action: "Admin financial credit",
        detail: `${creditModal.user.username || "user"} +${Number(creditForm.amount).toFixed(2)} USDT`,
      });
      setCreditConfirm(false);
      setCreditModal(null);
    } catch (err: any) {
      const msg = err?.message || "Credit failed";
      setError(msg);
      showSafeToast(msg);
      showAdminToast(msg, "error");
      pushAdminLog({ level: "error", action: "Admin financial credit failed", detail: msg });
    } finally {
      setCreditLoading(false);
    }
  };

  const runFraudAction = async () => {
    if (!detail?.user?._id || !fraudConfirm || fraudActionLoading) return;
    const id = String(detail.user._id);
    const note = fraudReason.trim();
    if (!note) {
      showSafeToast("A reason is required");
      showAdminToast("A reason is required", "error");
      return;
    }
    try {
      setFraudActionLoading(true);
      setError("");
      if (fraudConfirm === "flag") {
        await adminFetch(`/admin/users/${id}/fraud-flag`, {
          method: "POST",
          body: JSON.stringify({ reason: note }),
        });
        showAdminToast("Fraud flag applied", "success");
        refreshUserInList(id, { adminFraudFlag: true, adminFraudReason: note });
      } else {
        await adminFetch(`/admin/users/${id}/fraud-unflag`, {
          method: "POST",
          body: JSON.stringify({ reason: note }),
        });
        showAdminToast("Fraud flag removed", "success");
        refreshUserInList(id, { adminFraudFlag: false, adminFraudReason: "" });
      }
      const payload = await adminFetch(`/admin/users/${id}/detail`);
      const d = payload?.data;
      setDetail({ user: d?.user, directTeam: d?.directTeam || [], stats: d?.stats });
      setFraudConfirm(null);
      setFraudReason("");
    } catch (err: any) {
      const msg = err?.message || "Request failed";
      setError(msg);
      showSafeToast(msg);
      showAdminToast(msg, "error");
    } finally {
      setFraudActionLoading(false);
    }
  };

  const runBlockToggle = async () => {
    if (!confirm || confirmActionLoading) return;
    const { kind, user } = confirm;
    const id = user._id;
    if (!id || processingId) return;
    const path = kind === "block" ? `/admin/block/${id}` : `/admin/unblock/${id}`;
    try {
      setConfirmActionLoading(true);
      setProcessingId(id);
      setError("");
      await adminFetch(path, { method: "POST", body: JSON.stringify({}) });
      pushAdminLog({
        action: kind === "block" ? "User blocked" : "User unblocked",
        detail: getUserLabel(user),
      });
      showAdminToast(kind === "block" ? "User blocked" : "User unblocked", "success");
      setUsers((prev) =>
        prev.map((u) =>
          String(u._id) === String(id) ? { ...u, isBlocked: kind === "block" } : u
        )
      );
      setConfirm(null);
    } catch (err: any) {
      const msg = err?.message || "Request failed";
      setError(msg);
      showSafeToast(msg);
      showAdminToast(msg, "error");
      pushAdminLog({ level: "error", action: "User block/unblock failed", detail: msg });
    } finally {
      setProcessingId("");
      setConfirmActionLoading(false);
    }
  };

  return (
    <AdminLayout
      title="Realtime User Financial Monitor"
      subtitle="Live HybridEarn active USDT, rewards, and internal admin credits with immutable ledger-derived earning breakdowns."
    >
      <div className="mb-4 grid gap-3 lg:grid-cols-4">
        <MetricCard
          label="Realtime Available USDT"
          value={formatCurrency(summary?.totalAvailableUSDT)}
          accent="text-emerald-200"
        />
        <MetricCard
          label="Pending Withdrawal"
          value={formatCurrency(summary?.totalPendingWithdraw)}
          accent="text-amber-200"
        />
        <MetricCard
          label="Active Earning Users"
          value={String(summary?.activeEarningUsers ?? 0)}
          accent="text-cyan-200"
        />
        <MetricCard
          label="Runtime Refresh"
          value={refreshing ? "Refreshing" : "Live"}
          accent={refreshing ? "text-amber-200" : "text-emerald-200"}
          subtext={lastUpdated ? `Updated ${formatDate(lastUpdated)}` : "Awaiting first sync"}
        />
      </div>

      <div className="sticky top-[48px] z-20 mb-4 rounded-2xl border border-cyan-400/15 bg-[#071018]/90 p-3 shadow-[0_0_40px_rgba(34,211,238,0.08)] backdrop-blur-xl">
        <div className="grid gap-3 xl:grid-cols-[1fr_220px_180px_auto]">
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Realtime search: username, email, wallet address"
            className="rounded-xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-cyan-400"
          />
          <select
            value={financeFilter}
            onChange={(event) => {
              setPage(1);
              setFinanceFilter(event.target.value);
            }}
            className="rounded-xl border border-white/10 bg-[#071015] px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
          >
            {USER_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            value={minAvailable}
            onChange={(event) => {
              setPage(1);
              setMinAvailable(event.target.value);
            }}
            placeholder="Above X USDT"
            className="rounded-xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-cyan-400"
          />
          <button
            type="button"
            disabled={loading || refreshing}
            onClick={() => void loadUsers({ silent: false })}
            className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-xs font-bold uppercase tracking-wide text-cyan-100 shadow-[0_0_22px_rgba(34,211,238,0.1)] hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? "Syncing" : "Refresh"}
          </button>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {USER_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => {
                setPage(1);
                setFinanceFilter(filter.value);
              }}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                financeFilter === filter.value
                  ? "border border-cyan-300/50 bg-cyan-400/15 text-white"
                  : "border border-white/10 bg-white/[0.04] text-gray-400 hover:text-white"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <StatusMessage type="error" message={error} />

      {loading ? (
        <UserTableSkeleton />
      ) : !error && !users.length ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={[
            "Username",
            "Available USDT",
            "Pending Withdrawal",
            "Deposit Balance",
            "Reward Balance",
            "Total Earnings",
            "Team Earnings",
            "ROI Earnings",
            "Admin Credits",
            "Status",
            "Last Login",
            "Created Date",
            "Actions",
          ]}
          emptyText="No users match your filters"
          footer={
            <AdminPagination
              page={safePage}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          }
        >
          {slice.map((user) => {
            const busy = processingId === user._id;
            return (
              <tr key={user._id} className="hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="font-semibold text-white">{user.username || "—"}</div>
                  <div className="max-w-[180px] truncate text-[11px] text-gray-500">
                    {user.email || "—"}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-emerald-200 tabular-nums">
                  <div className="text-sm font-black">{formatCurrency(user.availableUSDT)}</div>
                  <div className="text-[10px] uppercase tracking-wide text-emerald-400/60">deposit + reward</div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-amber-200">
                  {formatCurrency(user.pendingWithdraw)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-gray-200">
                  {formatCurrency(user.depositBalance)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-cyan-100">
                  {formatCurrency(user.rewardBalance)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-violet-100">
                  {formatCurrency(user.totalEarnings)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-sky-200">
                  {formatCurrency(user.financial?.teamEarnings ?? user.referralEarnings)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-lime-200">
                  {formatCurrency(user.financial?.roiEarnings)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-fuchsia-200">
                  {formatCurrency(user.financial?.adminCredits)}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <StatusPill tone={user.isBlocked ? "danger" : user.adminFraudFlag ? "warning" : "success"}>
                      {user.isBlocked ? "Blocked" : user.adminFraudFlag ? "Fraud Review" : "Active"}
                    </StatusPill>
                    {user.isAdmin ? <StatusPill tone="info">Admin</StatusPill> : null}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-400">
                  {formatDate(user.lastLogin)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-400">
                  {formatDate(user.createdAt)}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={Boolean(processingId) || confirmActionLoading}
                        onClick={() => void openDetails(user)}
                        className="rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] text-gray-200 hover:bg-white/10"
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(processingId) || confirmActionLoading}
                        onClick={() => void openTeam(user)}
                        className="rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] text-gray-200 hover:bg-white/10"
                      >
                        Team
                      </button>
                      <button
                        type="button"
                        disabled={
                          Boolean(processingId) ||
                          confirmActionLoading ||
                          user.isBlocked ||
                          user.adminFraudFlag
                        }
                        onClick={() => openCreditModal(user, CREDIT_ACTIONS[0])}
                        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Credit
                      </button>
                    </div>
                    {user.isBlocked ? (
                      <button
                        type="button"
                        disabled={Boolean(processingId) || confirmActionLoading}
                        onClick={() => setConfirm({ kind: "unblock", user })}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {busy ? "…" : "Unblock"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(processingId) || confirmActionLoading}
                        onClick={() => setConfirm({ kind: "block", user })}
                        className="rounded-lg bg-amber-500/90 px-3 py-2 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-50"
                      >
                        {busy ? "…" : "Block"}
                      </button>
                    )}
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
        message={
          confirm
            ? confirm.kind === "block"
              ? `Block ${getUserLabel(confirm.user)}? They will not be able to use the app until unblocked.`
              : `Unblock ${getUserLabel(confirm.user)} and restore normal access?`
            : ""
        }
        confirmLabel={confirm?.kind === "block" ? "Block user" : "Unblock user"}
        cancelLabel="Cancel"
        danger={confirm?.kind === "block"}
        confirmLoading={confirmActionLoading}
        onCancel={() => !confirmActionLoading && setConfirm(null)}
        onConfirm={runBlockToggle}
      >
        {null}
      </ConfirmModal>

      <ConfirmModal
        open={Boolean(fraudConfirm)}
        title={fraudConfirm === "flag" ? "Flag user?" : "Remove fraud flag?"}
        message={
          fraudConfirm === "flag"
            ? `Flag ${detail?.user ? getUserLabel(detail.user) : "this user"} for fraud review. A reason will be stored in the audit log.`
            : `Clear the fraud flag for ${detail?.user ? getUserLabel(detail.user) : "this user"}?`
        }
        confirmLabel={fraudConfirm === "flag" ? "Flag user" : "Remove flag"}
        cancelLabel="Cancel"
        danger={fraudConfirm === "flag"}
        confirmLoading={fraudActionLoading}
        onCancel={() => {
          if (!fraudActionLoading) {
            setFraudConfirm(null);
            setFraudReason("");
          }
        }}
        onConfirm={runFraudAction}
      >
        <label className="block text-xs text-gray-400">
          Reason (required)
          <textarea
            value={fraudReason}
            onChange={(e) => setFraudReason(e.target.value)}
            rows={3}
            className="mt-2 w-full rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-sm text-white placeholder:text-gray-600"
            placeholder="Stored with the audit trail…"
          />
        </label>
      </ConfirmModal>

      {detailLoading ? (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl bg-black/80 px-4 py-2 text-sm text-white">
          Loading…
        </div>
      ) : null}

      {detail ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="presentation"
          onClick={() => setDetail(null)}
        >
          <div
            className={`${CARD} max-h-[85vh] w-full max-w-lg overflow-y-auto p-6`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white">User details</h3>
            {detail.user?.adminFraudFlag ? (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-100">
                🚨 Fraud Flag
                {detail.user?.adminFraudReason ? (
                  <span className="mt-1 block font-normal text-red-200/90">{detail.user.adminFraudReason}</span>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-500">No active fraud flag</p>
            )}
            <dl className="mt-4 space-y-2 text-sm">
              {[
                ["Username", detail.user?.username],
                ["Email", detail.user?.email],
                ["Balance", formatCurrency(detail.user?.balance)],
                ["Deposit balance", formatCurrency(detail.user?.depositBalance)],
                ["Reward balance", formatCurrency(detail.user?.rewardBalance)],
                [
                  "Hybrid spendable",
                  formatCurrency(
                    Number(detail.user?.depositBalance || 0) + Number(detail.user?.rewardBalance || 0)
                  ),
                ],
                ["Total invested", formatCurrency(detail.user?.totalInvested)],
                ["Total withdraw (lifetime)", formatCurrency(detail.user?.totalWithdraw)],
                ["Total deposits (hybrid credited)", formatCurrency(detail.stats?.totalDeposits ?? 0)],
                ["Total withdraw paid (hybrid)", formatCurrency(detail.stats?.totalWithdrawPaid ?? 0)],
                ["Salary earned (claimed)", formatCurrency(detail.stats?.salaryEarned ?? 0)],
                ["Team ROI income", formatCurrency(detail.stats?.referralEarnings ?? detail.user?.referralEarnings)],
                ["VIP", String(detail.user?.vipLevel ?? 0)],
                ["Created", formatDate(detail.user?.createdAt)],
                ["Blocked", detail.user?.isBlocked ? "Yes" : "No"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-white/5 py-1">
                  <dt className="text-gray-500">{k}</dt>
                  <dd className="text-right text-gray-200">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 ring-1 ring-emerald-500/10">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-emerald-200/80">
                    Financial Controls
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Credits write to the immutable ledger, active USDT balance, and admin audit.
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-300">
                  Audit visible
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {CREDIT_ACTIONS.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    disabled={
                      creditLoading ||
                      Boolean(processingId) ||
                      detail.user?.isBlocked ||
                      detail.user?.adminFraudFlag
                    }
                    onClick={() => openCreditModal(detail.user, action)}
                    className="rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-left text-[11px] font-semibold text-white transition hover:border-emerald-400/50 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {!detail.user?.adminFraudFlag ? (
                <button
                  type="button"
                  disabled={Boolean(processingId) || fraudActionLoading || confirmActionLoading}
                  onClick={() => {
                    setFraudReason("");
                    setFraudConfirm("flag");
                  }}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
                >
                  Flag User
                </button>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(processingId) || fraudActionLoading || confirmActionLoading}
                  onClick={() => {
                    setFraudReason("");
                    setFraudConfirm("unflag");
                  }}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  Remove Flag
                </button>
              )}
            </div>
            <button
              type="button"
              className="mt-6 w-full rounded-xl border border-white/15 py-2 text-sm text-gray-300 hover:bg-white/10"
              onClick={() => setDetail(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {creditModal && !creditConfirm ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          role="presentation"
          onClick={() => {
            if (!creditLoading) setCreditModal(null);
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-emerald-500/20 bg-[#080d12]/95 p-6 shadow-[0_0_60px_rgba(16,185,129,0.16)] ring-1 ring-white/10"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-financial-credit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-emerald-300/80">
                  Admin financial control
                </p>
                <h3 id="admin-financial-credit-title" className="mt-2 text-xl font-black text-white">
                  Admin Financial Credit
                </h3>
                <p className="mt-1 text-xs text-gray-400">
                  {creditModal.action.label} via internal admin credit ledger and active USDT balance.
                </p>
              </div>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-100">
                Ledger protected
              </span>
            </div>

            <div className="mt-5 grid gap-3">
              <label className="block text-xs font-semibold text-gray-400">
                Username
                <input
                  value={creditModal.user?.username || ""}
                  readOnly
                  className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white outline-none"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-semibold text-gray-400">
                  Amount (USDT)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={creditForm.amount}
                    onChange={(e) => setCreditForm((prev) => ({ ...prev, amount: e.target.value }))}
                    disabled={creditLoading}
                    placeholder="50.00"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-emerald-400 disabled:opacity-60"
                  />
                </label>
                <label className="block text-xs font-semibold text-gray-400">
                  Category
                  <select
                    value={creditForm.category}
                    onChange={(e) => setCreditForm((prev) => ({ ...prev, category: e.target.value }))}
                    disabled={creditLoading}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#071015] px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400 disabled:opacity-60"
                  >
                    {CREDIT_CATEGORIES.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-xs font-semibold text-gray-400">
                Reason
                <textarea
                  value={creditForm.reason}
                  onChange={(e) => setCreditForm((prev) => ({ ...prev, reason: e.target.value }))}
                  disabled={creditLoading}
                  rows={3}
                  placeholder="Promotional bonus, support recovery, cashback adjustment…"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-emerald-400 disabled:opacity-60"
                />
              </label>

              <label className="block text-xs font-semibold text-gray-400">
                Internal admin note
                <textarea
                  value={creditForm.internalAdminNote}
                  onChange={(e) =>
                    setCreditForm((prev) => ({ ...prev, internalAdminNote: e.target.value }))
                  }
                  disabled={creditLoading}
                  rows={2}
                  placeholder="Private audit context for operations review"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-gray-600 focus:border-emerald-400 disabled:opacity-60"
                />
              </label>
            </div>

            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-gray-400">
              Duplicate submissions are blocked with an idempotency key. Approved credits become withdrawable, ROI eligible, staking eligible active USDT without creating on-chain deposits.
            </div>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={creditLoading}
                onClick={() => setCreditModal(null)}
                className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={creditLoading}
                onClick={requestCreditConfirmation}
                className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_0_24px_rgba(16,185,129,0.25)] hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Review credit
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={creditConfirm}
        title="Confirm financial credit"
        message={
          creditModal
            ? `Credit ${creditModal.user?.username || "this user"} with ${Number(creditForm.amount || 0).toFixed(2)} USDT?\n\nCategory: ${creditForm.category}\nReason: ${creditForm.reason.trim()}`
            : ""
        }
        confirmLabel="Apply credit"
        cancelLabel="Back"
        confirmLoading={creditLoading}
        onCancel={() => !creditLoading && setCreditConfirm(false)}
        onConfirm={runFinancialCredit}
      >
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          This writes an immutable internal admin credit and a financial admin audit log before returning success.
        </div>
      </ConfirmModal>

      {teamOnly ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="presentation"
          onClick={() => setTeamOnly(null)}
        >
          <div
            className={`${CARD} max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white">
              Direct team — {teamOnly.user?.username}
            </h3>
            <p className="mt-1 text-xs text-gray-500">{teamOnly.directTeam?.length || 0} referrals</p>
            <ul className="mt-4 space-y-2 text-sm">
              {teamOnly.directTeam?.length ? (
                teamOnly.directTeam.map((m: any) => (
                  <li
                    key={String(m._id)}
                    className="flex flex-wrap justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
                  >
                    <span className="font-medium text-white">{m.username}</span>
                    <span className="text-xs text-gray-500">{m.email}</span>
                    <span className="text-xs text-emerald-300 tabular-nums">
                      Dep {formatCurrency(m.depositBalance)}
                    </span>
                  </li>
                ))
              ) : (
                <li className="text-gray-500">No direct referrals.</li>
              )}
            </ul>
            <button
              type="button"
              className="mt-6 w-full rounded-xl border border-white/15 py-2 text-sm text-gray-300 hover:bg-white/10"
              onClick={() => setTeamOnly(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
}

function MetricCard({
  label,
  value,
  accent,
  subtext,
}: {
  label: string;
  value: string;
  accent: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-[0_0_36px_rgba(34,211,238,0.06)] ring-1 ring-cyan-400/5">
      <p className="text-[10px] font-bold uppercase tracking-[0.26em] text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-black tracking-tight ${accent}`}>{value}</p>
      <p className="mt-1 text-[11px] text-gray-500">{subtext || "HybridEarn live state"}</p>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: string; children: any }) {
  const styles =
    tone === "danger"
      ? "border-red-500/30 bg-red-500/15 text-red-200"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/15 text-amber-100"
        : tone === "info"
          ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-100"
          : "border-emerald-500/30 bg-emerald-500/15 text-emerald-200";

  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${styles}`}>
      {children}
    </span>
  );
}

function UserTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
      <div className="grid gap-px bg-white/5">
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="grid grid-cols-4 gap-3 bg-[#080b13] p-4 md:grid-cols-8">
            {Array.from({ length: 8 }).map((__, cell) => (
              <div
                key={cell}
                className="h-4 animate-pulse rounded-full bg-white/10"
                style={{ opacity: cell === 0 ? 0.9 : 0.45 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
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
