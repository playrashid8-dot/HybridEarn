import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminSettingsPage() {
  return (
    <AdminOpsSnapshotPage
      mode="settings"
      title="Operations settings"
      subtitle="Read-only runtime configuration until audited settings mutation endpoints are added."
    />
  );
}
