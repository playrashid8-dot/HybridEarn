import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminStakingPage() {
  return (
    <AdminOpsSnapshotPage
      mode="staking"
      title="Staking operations"
      subtitle="Live platform balance visibility; no staking mutation controls are exposed without backend audit endpoints."
    />
  );
}
