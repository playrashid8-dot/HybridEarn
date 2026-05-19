"use client";

import { useCallback, useEffect, useState } from "react";
import AdminLayout, { adminFetch, getUserLabel } from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import ConfirmModal from "../../../components/admin/ConfirmModal";
import { CARD } from "../../../lib/adminTheme";
import { showAdminToast, showSafeToast } from "../../../lib/toast";
import EmptyState from "../../../components/EmptyState";

const riskBadge = {
  high: "bg-red-500/20 text-red-200 ring-1 ring-red-500/35",
  medium: "bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/35",
  low: "bg-white/10 text-gray-300 ring-1 ring-white/15",
};

export default function AdminFraudPage() {
  const [signals, setSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "block" | "flag" | "unflag"; row: any }>(null);
  const [flagReason, setFlagReason] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const payload = await adminFetch("/admin/fraud-signals");
      setSignals(payload?.data?.signals ?? []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load fraud signals";
      if (!silent) showSafeToast(msg);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(true), 15000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = signals.filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      String(s.username || "").toLowerCase().includes(q) ||
      String(s.email || "").toLowerCase().includes(q)
    );
  });

  const runConfirm = async () => {
    if (!confirm) return;
    const id = String(confirm.row.userId);
    const trimmed = flagReason.trim();
    if ((confirm.kind === "flag" || confirm.kind === "unflag") && !trimmed) {
      showAdminToast("Reason is required", "error");
      return;
    }
    setBusyId(id);
    try {
      if (confirm.kind === "flag") {
        await adminFetch(`/admin/users/${id}/fraud-flag`, {
          method: "POST",
          body: JSON.stringify({ reason: trimmed }),
        });
        showAdminToast("User flagged", "success");
      } else if (confirm.kind === "unflag") {
        await adminFetch(`/admin/users/${id}/fraud-unflag`, {
          method: "POST",
          body: JSON.stringify({ reason: trimmed }),
        });
        showAdminToast("Flag removed", "success");
      } else {
        await adminFetch(`/admin/block/${id}`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        showAdminToast("User blocked", "warning");
      }
      setConfirm(null);
      setFlagReason("");
      await load();
    } catch (e: unknown) {
      showAdminToast(e instanceof Error ? e.message : "Action failed", "error");
    } finally {
      setBusyId("");
    }
  };

  return (
    <AdminLayout
      title="Fraud panel"
      subtitle="Heuristic risk signals — rapid withdrawals, deposit mismatch, new accounts. Review before action."
    >
      <div className={`${CARD} mb-6 border-amber-400/20 bg-amber-500/5 p-4 text-sm text-amber-100`}>
        Signals are informational. Flagging stores an admin-only note; blocking uses the standard user endpoint.
      </div>

      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search username or email"
          className="w-full max-w-md rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none placeholder:text-gray-500 focus:border-purple-500"
        />
      </div>

      {loading ? (
        <Loader label="Loading signals…" />
      ) : filtered.length === 0 ? (
        <EmptyState text="No suspicious users match filters — or nothing triggered heuristics." />
      ) : (
        <Table columns={["User", "Risk", "Reason", "Actions"]} emptyText="No rows" footer={null}>
          {filtered.map((row) => {
            const id = String(row.userId);
            const risk = String(row.riskLevel || "low").toLowerCase() as keyof typeof riskBadge;
            return (
              <tr key={id} className="hover:bg-white/[0.03]">
                <td className="px-4 py-4">
                  <div className="font-medium text-white">
                    {getUserLabel({ username: row.username, email: row.email })}
                  </div>
                  {row.adminFraudFlag ? (
                    <span className="mt-1 inline-block rounded-md bg-red-500/20 px-2 py-0.5 text-[10px] text-red-200">
                      🚨 Fraud Flag
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-4">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs capitalize ${riskBadge[risk] || riskBadge.low}`}
                  >
                    {risk}
                  </span>
                </td>
                <td className="max-w-md px-4 py-4 text-sm text-gray-300">
                  <ul className="list-inside list-disc space-y-1 text-xs">
                    {(row.reasons || []).map((r: string, i: number) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-4">
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => {
                        setFlagReason("");
                        setConfirm({ kind: "flag", row });
                      }}
                      className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
                    >
                      Flag user
                    </button>
                    {row.adminFraudFlag ? (
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => {
                          setFlagReason("");
                          setConfirm({ kind: "unflag", row });
                        }}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                      >
                        Remove flag
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={Boolean(busyId) || row.isBlocked}
                      onClick={() => setConfirm({ kind: "block", row })}
                      className="rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-500/25 disabled:opacity-50"
                    >
                      {row.isBlocked ? "Blocked" : "Block user"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <ConfirmModal
        open={Boolean(confirm)}
        title={
          confirm?.kind === "flag"
            ? "Flag user?"
            : confirm?.kind === "unflag"
              ? "Remove fraud flag?"
              : "Block user?"
        }
        message={
          confirm
            ? confirm.kind === "flag"
              ? `Flag ${getUserLabel({ username: confirm.row.username, email: confirm.row.email })} for fraud review?`
              : confirm.kind === "unflag"
                ? `Remove the fraud flag for ${getUserLabel({ username: confirm.row.username, email: confirm.row.email })}?`
                : `Block ${getUserLabel({ username: confirm.row.username, email: confirm.row.email })}? They will lose app access until unblocked.`
            : ""
        }
        confirmLabel={confirm?.kind === "flag" ? "Flag" : confirm?.kind === "unflag" ? "Remove flag" : "Block"}
        cancelLabel="Cancel"
        danger={confirm?.kind === "block"}
        confirmLoading={Boolean(busyId)}
        onCancel={() => {
          if (!busyId) {
            setConfirm(null);
            setFlagReason("");
          }
        }}
        onConfirm={runConfirm}
      >
        {confirm?.kind === "flag" || confirm?.kind === "unflag" ? (
          <label className="block text-xs text-gray-400">
            Reason (required)
            <textarea
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-sm text-white placeholder:text-gray-600"
              placeholder="Visible in audit trail…"
            />
          </label>
        ) : null}
      </ConfirmModal>
    </AdminLayout>
  );
}
