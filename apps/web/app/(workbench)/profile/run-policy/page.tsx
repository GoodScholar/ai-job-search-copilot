import type { Metadata } from "next";
import { AccountRunPolicyView } from "@/components/workbench/account-run-policy-view";
import { getAccountRunPolicy } from "@/lib/server/account-run-policies";
export const metadata: Metadata = { title: "账户运行策略 | AI Job Search Copilot" };
export default async function AccountRunPolicyPage() { return <AccountRunPolicyView initialPolicy={await getAccountRunPolicy()} />; }
