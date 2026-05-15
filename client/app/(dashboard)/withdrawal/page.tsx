import { redirect } from "next/navigation";

export default function LegacyWithdrawalRedirectPage() {
  redirect("/withdraw");
}
