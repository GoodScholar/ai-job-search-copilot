import type { Metadata } from "next";
import { AccountRunPolicyView } from "@/components/workbench/account-run-policy-view";
import { getAccountRunControl, getAccountRunPolicy } from "@/lib/server/account-run-policies";
export const metadata: Metadata = { title: "账户运行策略 | AI Job Search Copilot" };
export default async function AccountRunPolicyPage() {
  const [policy, control] = await Promise.all([getAccountRunPolicy(), getAccountRunControl().catch(() => null)]);
  return <AccountRunPolicyView initialControl={control} initialPolicy={policy} />;
}
