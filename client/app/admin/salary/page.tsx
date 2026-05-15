"use client";

import { useCallback, useEffect, useState } from "react";
import AdminLayout, { adminFetch, formatCurrency, formatDate } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import AdminPagination from "../../../components/admin/AdminPagination";
import { CARD } from "../../../lib/adminTheme";
import { showSafeToast } from "../../../lib/toast";
import EmptyState from "../../../components/EmptyState";

const PAGE_SIZE = 25;

export default function AdminSalaryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [totalSalaryPaid, setTotalSalaryPaid] = useState(0);
  const [stageDistribution, setStageDistribution] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (silent = false) => {
      try {
        if (!silent) setLoading(true);
        const qs = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_SIZE),
          search: debounced.trim(),
        });
        const payload = await adminFetch(`/admin/salary-payouts?${qs}`);
        const d = payload?.data;
        setRows(d?.rows ?? []);
        setTotalSalaryPaid(d?.totalSalaryPaid ?? 0);
        setStageDistribution(d?.stageDistribution ?? []);
        setPagination({
          page: d?.pagination?.page ?? 1,
          totalPages: d?.pagination?.totalPages ?? 1,
          total: d?.pagination?.total ?? 0,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to load salary data";
        if (!silent) showSafeToast(msg);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [page, debounced]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  useEffect(() => {
    const id = setInterval(() => void load(true), 15000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <AdminLayout
      title="Salary monitor"
      subtitle="Recorded salary claims — totals and stage distribution."
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search username or email"
          className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-purple-500"
        />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className={`${CARD} p-5`}>
          <h2 className="text-sm font-semibold text-white">Total salary paid (recorded)</h2>
          <p className="mt-2 text-2xl font-bold tabular-nums text-emerald-300">
            {formatCurrency(totalSalaryPaid)}
          </p>
        </div>
        <div className={`${CARD} p-5`}>
          <h2 className="text-sm font-semibold text-white">Stage distribution</h2>
          <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto text-sm">
            {stageDistribution.length === 0 ? (
              <li className="text-gray-500">No salary payouts yet.</li>
            ) : (
              stageDistribution.map((s) => (
                <li key={s.stage} className="flex justify-between gap-2 border-b border-white/5 pb-2 text-gray-300">
                  <span>Stage {s.stage}</span>
                  <span className="tabular-nums text-white">
                    {s.count} × {formatCurrency(s.amount ?? 0)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      {loading ? (
        <Loader label="Loading salary payouts…" />
      ) : rows.length === 0 ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={["User", "Stage", "Amount", "Date"]}
          emptyText="No rows"
          footer={
            <AdminPagination
              page={page}
              pageSize={PAGE_SIZE}
              total={pagination.total}
              onPageChange={setPage}
            />
          }
        >
          {rows.map((r) => (
            <tr key={`${r.userId}-${r.claimedAt}-${r.stage}`} className="hover:bg-white/[0.03]">
              <td className="px-4 py-4">
                <div className="font-medium text-white">{r.username || "—"}</div>
                <div className="text-xs text-gray-500">{r.email || ""}</div>
              </td>
              <td className="px-4 py-4 tabular-nums text-gray-200">{r.stage}</td>
              <td className="px-4 py-4 tabular-nums text-emerald-300">{formatCurrency(r.amount)}</td>
              <td className="px-4 py-4 text-xs text-gray-400">{formatDate(r.claimedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
    </AdminLayout>
  );
}
