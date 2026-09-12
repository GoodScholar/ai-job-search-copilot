"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { RunPreflightPanel } from "@/components/workbench/run-preflight-panel";
import type { RecommendationReevaluationActionResult } from "./actions";

function SubmitButton({ pending }: { pending: boolean }) {
  return <Button className="workbench-touch-target" disabled={pending} size="lg" type="submit">{pending ? "正在提交重新评估…" : "重新评估此岗位"}</Button>;
}

/** A single user intent owns one stable key until the server action settles. */
export function ReevaluationForm({ action }: { action: (formData: FormData) => RecommendationReevaluationActionResult | Promise<RecommendationReevaluationActionResult> }) {
  const [initialKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(async (current: { key: string; failed: boolean; confirmation: RecommendationReevaluationActionResult | null }, formData: FormData) => {
    try {
      const result = await action(formData);
      if (result.kind === "started") return { key: crypto.randomUUID(), failed: false, confirmation: null };
      return { ...current, failed: false, confirmation: result };
    } catch {
      return { ...current, failed: true };
    }
  }, { key: initialKey, failed: false, confirmation: null });
  const confirmation = state.confirmation;
  const report = confirmation?.kind === "blocked" || confirmation?.kind === "warning_confirmation_required" ? confirmation.preflight : null;
  return <form action={formAction}>
    <input name="idempotencyKey" type="hidden" value={state.key} />
    <input name="warningFingerprint" type="hidden" value={confirmation?.kind === "warning_confirmation_required" ? confirmation.preflight.warningFingerprint ?? "" : ""} />
    {state.failed ? <p role="alert">重新评估未启动，请重试。</p> : null}
    {report ? <RunPreflightPanel report={report} unavailable={false} /> : null}
    {confirmation?.kind === "blocked" ? <p role="alert">当前无法重新评估，请先处理运行前检查中的阻塞项。</p> : null}
    {confirmation?.kind === "account_run_stopped" ? <><p role="alert">账户已停止全部运行，请先解除全局停止。</p><Link className={buttonVariants({ className: "workbench-touch-target", size: "lg", variant: "outline" })} href="/profile/run-policy">管理运行策略</Link></> : confirmation?.kind === "warning_confirmation_required" ? <><p role="status">重新评估前需要你确认当前提示。</p><Button className="workbench-touch-target" disabled={pending} size="lg" type="submit">我已了解，仍要重新评估</Button></> : confirmation?.kind !== "blocked" ? <SubmitButton pending={pending} /> : null}
  </form>;
}
