import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminAuditPage() {
  return (
    <AdminOpsSnapshotPage
      mode="audit"
      title="Immutable audit center"
      subtitle="Append-only admin audit events from live backend records."
    />
  );
}
