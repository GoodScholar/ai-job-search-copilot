"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { CalibrationProposal } from "@job-copilot/contracts/recommendations";

export function CalibrationProposals({ proposals, reviseAction, resolveAction }: { proposals: CalibrationProposal[]; reviseAction: (proposalId: string, formData: FormData) => Promise<void>; resolveAction: (proposalId: string, formData: FormData) => Promise<void> }) {
  const [pending, startTransition] = useTransition(); const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  if (!proposals.length) return null;
  const submit = (event: FormEvent<HTMLFormElement>, action: (formData: FormData) => Promise<void>, success: string) => {
    event.preventDefault(); setMessage(null); setError(null);
    const formData = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.name) formData.set(submitter.name, submitter.value);
    startTransition(() => { void action(formData).then(() => setMessage(success)).catch(() => setError("操作未完成，请刷新后重试。")); });
  };
  return <section aria-labelledby="calibration-proposals-title" className="flex flex-col gap-4"><h2 id="calibration-proposals-title">校准建议</h2>{message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}{proposals.map((proposal) => <article key={proposal.proposalId} className="flex flex-col gap-3"><h3>基于 {proposal.evidenceCount} 条忽略反馈的建议</h3><p>策略：{proposal.revision.strategy}；预计影响 {proposal.revision.impactPreview.estimatedAffectedCount} / {proposal.revision.impactPreview.sampleSize} 项。</p><p>规则差异：{Object.keys(proposal.revision.impactPreview.ruleDiff).join("、") || "暂无字段差异"}</p><p>状态：{proposal.status}</p>{proposal.status === "pending" ? <><form onSubmit={(event) => submit(event, reviseAction.bind(null, proposal.proposalId), "校准建议已修改。")} className="flex flex-wrap gap-2"><input name="strategy" defaultValue={proposal.revision.strategy} aria-label="修改策略" /><input name="minimumOverallScore" type="number" defaultValue={proposal.revision.ruleConfig.minimumOverallScore} aria-label="最低匹配分" /><input name="minimumEvidenceDimensions" type="number" defaultValue={proposal.revision.ruleConfig.minimumEvidenceDimensions} aria-label="最低证据维度" /><input type="hidden" name="sampleSize" value={proposal.revision.impactPreview.sampleSize} /><input type="hidden" name="estimatedAffectedCount" value={proposal.revision.impactPreview.estimatedAffectedCount} /><input type="hidden" name="expectedVersion" value={proposal.version} /><input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} /><button className="workbench-touch-target" disabled={pending} type="submit">修改建议</button></form><form onSubmit={(event) => submit(event, resolveAction.bind(null, proposal.proposalId), "校准建议已处理。")} className="flex flex-wrap gap-2"><input type="hidden" name="expectedVersion" value={proposal.version} /><input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} /><button className="workbench-touch-target" disabled={pending} type="submit" name="action" value="approved">批准建议</button><button className="workbench-touch-target" disabled={pending} type="submit" name="action" value="rejected">拒绝建议</button></form></> : null}</article>)}</section>;
}
