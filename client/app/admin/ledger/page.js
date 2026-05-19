"use client";

import { useMemo, useEffect, useState } from "react";
import AdminLayout, {
  adminFetch,
  formatCurrency,
  formatDate,
} from "../../../components/admin/AdminLayout";
import Loader from "../../../components/admin/Loader";
import Table from "../../../components/admin/Table";
import EmptyState from "../../../components/EmptyState";
import { showSafeToast } from "../../../lib/toast";

const ROW_CAP = 100;

export default function AdminLedgerPage() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const safeEntries = useMemo(() => entries.slice(0, ROW_CAP), [entries]);

  useEffect(() => {
    let active = true;

    const loadLedger = async () => {
      try {
        setLoading(true);
        setError("");
        const payload = await adminFetch("/admin/ledger");
        const nextEntries =
          payload?.data?.ledger ||
          payload?.data?.entries ||
          payload?.ledger ||
          payload?.entries ||
          [];
        if (active) setEntries(nextEntries);
      } catch (err) {
        if (active) {
          const msg = err.message || "Failed to load ledger";
          setError(msg);
          showSafeToast(msg);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadLedger();

    return () => {
      active = false;
    };
  }, []);

  return (
    <AdminLayout
      title="Ledger"
      subtitle="View credit and debit entries tied to deposits and withdrawals."
    >
      <StatusMessage type="error" message={error} />

      {loading ? (
        <Loader label="Loading ledger..." />
      ) : !error && !entries.length ? (
        <EmptyState text="No records found" />
      ) : (
        <Table
          columns={["Type", "Amount", "Reference", "Date"]}
          emptyText="No ledger entries found"
        >
          {safeEntries.map((entry) => (
            <tr key={entry._id} className="hover:bg-white/[0.03]">
              <td className="whitespace-nowrap px-4 py-4">
                <span
                  className={`rounded-full px-3 py-1 text-xs capitalize ${
                    entry.type === "credit"
                      ? "bg-green-500/15 text-green-300"
                      : "bg-red-500/15 text-red-300"
                  }`}
                >
                  {entry.type || "-"}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-gray-100">
                {formatCurrency(entry.amount)}
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-gray-300 capitalize">
                {entry.referenceType || entry.reference || "-"}
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-gray-400">
                {formatDate(entry.createdAt || entry.date)}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </AdminLayout>
  );
}

function StatusMessage({ type = "success", message }) {
  if (!message) return null;

  const styles =
    type === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-100"
      : "border-green-500/20 bg-green-500/10 text-green-100";

  return <div className={`mb-4 rounded-xl border p-3 text-sm ${styles}`}>{message}</div>;
}
