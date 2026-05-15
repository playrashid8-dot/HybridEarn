"use client";

import { useEffect, useMemo, useState } from "react";
import AdminLayout, {
  adminFetch,
  formatCurrency,
  formatDate,
  getUserLabel,
} from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import AdminPagination from "../../../components/admin/AdminPagination";
import ConfirmModal from "../../../components/admin/ConfirmModal";
import { CARD } from "../../../lib/adminTheme";
import { pushAdminLog } from "../../../lib/adminActivityLog";
import EmptyState from "../../../components/EmptyState";
import { showAdminToast, showSafeToast } from "../../../lib/toast";

const PAGE_SIZE = 25;
const ROW_CAP = 2000;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
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

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let active = true;

    const loadUsers = async () => {
      try {
        setLoading(true);
        setError("");
        const payload = await adminFetch("/admin/users");
        const nextUsers = payload?.data?.users || payload?.users || [];
        if (active) setUsers(nextUsers);
      } catch (err: any) {
        if (active) {
          const msg = err?.message || "Failed to load users";
          setError(msg);
          showSafeToast(msg);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadUsers();

    return () => {
      active = false;
    };
  }, []);

  const safeUsers = useMemo(() => users.slice(0, ROW_CAP), [users]);

  const filteredUsers = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();

    return safeUsers.filter((user) => {
      const matchesSearch =
        !query ||
        user.username?.toLowerCase().includes(query) ||
        user.email?.toLowerCase().includes(query);
      const status = user.isBlocked ? "blocked" : "active";
      const matchesStatus = statusFilter === "all" || statusFilter === status;

      return matchesSearch && matchesStatus;
    });
  }, [debouncedSearch, statusFilter, safeUsers]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, users.length]);

  const total = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = filteredUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

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
      title="User management"
      subtitle="Search, filter, block or unblock, inspect account and direct team."
    >
      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_180px]">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by username or email"
          className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-purple-500"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-xl border border-white/10 bg-[#0b0b0f] px-4 py-3 text-sm text-white outline-none focus:border-purple-500"
        >
          <option value="all">All users</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>

      <StatusMessage type="error" message={error} />

      {loading ? (
        <Loader label="Loading users…" />
      ) : !error && !users.length ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={[
            "Username",
            "Email",
            "Balance",
            "Total deposit",
            "Total withdraw",
            "Fraud",
            "Status",
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
                <td className="whitespace-nowrap px-4 py-4">
                  <div className="font-medium text-white">{user.username || "—"}</div>
                </td>
                <td className="max-w-[200px] truncate px-4 py-4 text-sm text-gray-400">
                  {user.email || "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-emerald-300 tabular-nums">
                  {formatCurrency(user.balance)}
                </td>
                <td className="whitespace-nowrap px-4 py-4 tabular-nums text-gray-200">
                  {formatCurrency(user.totalInvested ?? 0)}
                </td>
                <td className="whitespace-nowrap px-4 py-4 tabular-nums text-sky-200">
                  {formatCurrency(user.totalWithdraw ?? 0)}
                </td>
                <td className="whitespace-nowrap px-4 py-4">
                  {user.adminFraudFlag ? (
                    <span className="inline-flex rounded-md bg-red-500/20 px-2 py-1 text-[10px] font-medium text-red-200 ring-1 ring-red-500/30">
                      🚨 Fraud Flag
                    </span>
                  ) : (
                    <span className="text-xs text-gray-600">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-4">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs ${
                      user.isBlocked
                        ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/30"
                        : "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                    }`}
                  >
                    {user.isBlocked ? "Blocked" : "Active"}
                  </span>
                </td>
                <td className="px-4 py-4">
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

function StatusMessage({ type = "success", message }: { type?: string; message: string }) {
  if (!message) return null;

  const styles =
    type === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-100"
      : "border-green-500/20 bg-green-500/10 text-green-100";

  return <div className={`mb-4 rounded-xl border p-3 text-sm ${styles}`}>{message}</div>;
}
