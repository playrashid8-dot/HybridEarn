import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminRoiPage() {
  return (
    <AdminOpsSnapshotPage
      mode="roi"
      title="ROI operations"
      subtitle="ROI queue health and recovery-safe runtime status from the live operations snapshot."
    />
  );
}
