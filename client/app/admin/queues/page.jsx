import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminQueuesPage() {
  return (
    <AdminOpsSnapshotPage
      mode="queues"
      title="Queue observability"
      subtitle="BullMQ and runtime queue state with no unsafe replay controls."
    />
  );
}
