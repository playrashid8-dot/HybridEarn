import AdminOpsSnapshotPage from "../../../components/admin/AdminOpsSnapshotPage";

export default function AdminReferralsPage() {
  return (
    <AdminOpsSnapshotPage
      mode="referrals"
      title="Referral operations"
      subtitle="Live financial totals for referral operations; mutation controls require audited backend endpoints."
    />
  );
}
