import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminTreasuryPage() {
  return (
    <AdminOpsSnapshotPage
      mode="treasury"
      title="Treasury center"
      subtitle="Read-only treasury exposure, liabilities, and hot wallet health from the live operations snapshot."
    />
  );
}
