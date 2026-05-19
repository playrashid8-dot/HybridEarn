import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminRuntimePage() {
  return (
    <AdminOpsSnapshotPage
      mode="runtime"
      title="Runtime monitor"
      subtitle="API uptime, memory, CPU, Mongo, Redis, RPC, worker heartbeat, and polling fallback state."
    />
  );
}
