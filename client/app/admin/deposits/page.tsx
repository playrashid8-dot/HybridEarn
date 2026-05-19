"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminLayout, {
  adminFetch,
  formatCurrency,
  formatDate,
  getUserLabel,
} from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import AdminPagination from "../../../components/admin/AdminPagination";
import { depositStatusClasses } from "../../../components/admin/adminStatusClasses";
import { CARD } from "../../../lib/adminTheme";
import EmptyState from "../../../components/EmptyState";
import { showSafeToast } from "../../../lib/toast";

const PAGE_SIZE = 25;
const ROW_CAP = 3000;

function depositUiStatus(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "detected") return { label: "Pending", cls: depositStatusClasses(s) };
  if (s === "credited" || s === "swept") return { label: "Confirmed", cls: depositStatusClasses(s) };
  if (s === "failed") return { label: "Failed", cls: depositStatusClasses(s) };
  return { label: status || "—", cls: depositStatusClasses(s) };
}

function startOfTodayIso() {
  const s = new Date();
  s.setHours(0, 0, 0, 0);
  return s.toISOString();
}

function sevenDaysAgoIso() {
  const s = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  s.setHours(0, 0, 0, 0);
  return s.toISOString();
}

export default function AdminDepositsPage() {
  const [deposits, setDeposits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [rangePreset, setRangePreset] = useState<"all" | "today" | "7d" | "custom">("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set("limit", "3000");
    if (rangePreset === "today") {
      qs.set("from", startOfTodayIso());
    } else if (rangePreset === "7d") {
      qs.set("from", sevenDaysAgoIso());
    } else if (rangePreset === "custom" && customFrom) {
      const d = new Date(customFrom);
      if (!Number.isNaN(d.getTime())) qs.set("from", d.toISOString());
      if (customTo) {
        const e = new Date(customTo);
        if (!Number.isNaN(e.getTime())) qs.set("to", e.toISOString());
      }
    }
    return qs.toString();
  }, [rangePreset, customFrom, customTo]);

  const loadDeposits = useCallback(
    async (silent = false) => {
      try {
        if (!silent) {
          setLoading(true);
          setError("");
        }
        const payload = await adminFetch(`/admin/deposits?${queryString}`);
        setDeposits(payload?.data?.deposits || payload?.deposits || []);
        if (silent) setError("");
      } catch (err: any) {
        const msg = err?.message || "Failed to load deposits";
        if (!silent) {
          setError(msg);
          showSafeToast(msg);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [queryString]
  );

  useEffect(() => {
    void loadDeposits(false);
  }, [loadDeposits]);

  useEffect(() => {
    const id = window.setInterval(() => void loadDeposits(true), 15000);
    return () => clearInterval(id);
  }, [loadDeposits]);

  const safeDeposits = useMemo(() => deposits.slice(0, ROW_CAP), [deposits]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return safeDeposits.filter((deposit) => {
      const st = String(deposit.status || "").toLowerCase();
      const okStatus =
        statusFilter === "all" ||
        st === statusFilter ||
        (statusFilter === "pending" && st === "detected") ||
        (statusFilter === "confirmed" && (st === "credited" || st === "swept"));
      const user = deposit.userId;
      const label = getUserLabel(user).toLowerCase();
      const email = (user?.email || "").toLowerCase();
      const tx = (deposit.txHash || "").toLowerCase();
      const okSearch = !q || label.includes(q) || email.includes(q) || tx.includes(q);
      return okStatus && okSearch;
    });
  }, [safeDeposits, debouncedSearch, statusFilter]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, deposits.length, rangePreset, customFrom, customTo]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <AdminLayout
      title="Deposits monitor"
      subtitle="Hybrid deposits with quick range filters — auto-refreshes every 15 seconds."
    >
      <div className={`${CARD} mb-4 flex flex-wrap gap-2 p-3`}>
        <span className="w-full text-xs text-gray-500">Date range</span>
        {(
          [
            ["all", "All"],
            ["today", "Today"],
            ["7d", "Last 7 days"],
            ["custom", "Custom"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setRangePreset(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              rangePreset === key
                ? "bg-purple-600 text-white"
                : "border border-white/10 bg-black/30 text-gray-300 hover:bg-white/10"
            }`}
          >
            {label}
          </button>
        ))}
        {rangePreset === "custom" ? (
          <div className="flex w-full flex-wrap items-center gap-2 pt-2">
            <input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
            <span className="text-gray-500">→</span>
            <input
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
            />
          </div>
        ) : null}
      </div>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search user, email, or tx hash"
          className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-purple-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-xl border border-white/10 bg-[#0b0b0f] px-4 py-3 text-sm text-white outline-none focus:border-purple-500 lg:w-52"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending (detected)</option>
          <option value="confirmed">Confirmed</option>
          <option value="detected">Detected</option>
          <option value="credited">Credited</option>
          <option value="swept">Swept</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <StatusMessage type="error" message={error} />

      {loading ? (
        <Loader label="Loading deposits…" />
      ) : !error && !deposits.length ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={["User", "Amount", "Status", "TX hash", "Time"]}
          emptyText="No deposits match your filters"
          footer={
            <AdminPagination
              page={safePage}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          }
        >
          {slice.map((deposit) => {
            const ui = depositUiStatus(deposit.status);
            return (
              <tr key={deposit._id} className="hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-4 py-4">
                  <div className="font-medium text-white">{getUserLabel(deposit.userId)}</div>
                  {deposit.userId?.email ? (
                    <div className="text-xs text-gray-500">{deposit.userId.email}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-emerald-300 tabular-nums">
                  {formatCurrency(deposit.amount)}
                </td>
                <td className="whitespace-nowrap px-4 py-4">
                  <span className={`inline-flex rounded-full px-3 py-1 text-xs ${ui.cls}`}>
                    {ui.label}
                  </span>
                </td>
                <td className="max-w-[min(320px,50vw)] px-4 py-4">
                  <span className="font-mono text-xs text-gray-300 break-all">
                    {deposit.txHash || "—"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-xs text-gray-400">
                  {formatDate(deposit.createdAt)}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </AdminLayout>
  );
}

function StatusMessage({ type = "error", message }: { type?: string; message: string }) {
  if (!message) return null;

  const styles =
    type === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-100"
      : "border-green-500/20 bg-green-500/10 text-green-100";

  return <div className={`mb-4 rounded-xl border p-3 text-sm ${styles}`}>{message}</div>;
}
