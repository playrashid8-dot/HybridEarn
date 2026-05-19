import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminRecoveryPage() {
  return (
    <AdminOpsSnapshotPage
      mode="recovery"
      title="Recovery center"
      subtitle="Failed job and recovery worker visibility backed by existing safe recovery APIs."
    />
  );
}
