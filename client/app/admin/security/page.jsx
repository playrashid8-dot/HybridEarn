import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminSecurityPage() {
  return (
    <AdminOpsSnapshotPage
      mode="security"
      title="Security center"
      subtitle="Duplicate, replay, nonce, and treasury isolation controls reported from backend runtime state."
    />
  );
}
