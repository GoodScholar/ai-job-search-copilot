"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { CalibrationProposal } from "@job-copilot/contracts/recommendations";

type Strategy = CalibrationProposal["revision"]["strategy"];
type Action = (proposalId: string, formData: FormData) => Promise<void>;
type SubmitAction = (formData: FormData) => Promise<void>;

const strategies: Record<Strategy, string> = { require_related_evidence: "补强相关证据", raise_quality_bar: "提高推荐质量门槛", exclude_evidence_opportunities: "排除已处理岗位" };
const statuses = { pending: "待审核", approved: "已批准", rejected: "已拒绝" } as const;
const reasons = { ROLE_DIRECTION: "岗位方向不符", LOCATION: "地点或工作方式不合适", SALARY: "薪酬不符合预期", COMPANY: "公司不符合偏好", INDUSTRY: "行业不符合偏好", SENIORITY: "岗位级别不合适", MISMATCH: "整体匹配度不足", EXPIRED: "岗位已过期", ALREADY_HANDLED: "该岗位已处理" } as const;
const dimensions = { skills: "技能", experience: "经验", project_depth: "项目深度", career_direction: "岗位方向", location_logistics: "地点与工作方式", qualification_risk: "资格要求" } as const;
const fields: Record<string, string> = { minimumOverallScore: "最低匹配分", minimumEvidenceDimensions: "最低证据维度", requiredEvidenceDimensions: "必须具备的证据维度", excludedOpportunityIds: "排除岗位" };
function displayValue(field: string, input: unknown) {
  if (field === "requiredEvidenceDimensions") return (input as string[]).map((item) => dimensions[item as keyof typeof dimensions]).join("、") || "无";
  if (field === "excludedOpportunityIds") return `${(input as string[]).length} 个岗位`;
  return String(input);
}

function ProposalOperationControls({ proposal, pending, submit, reviseAction, resolveAction }: { proposal: CalibrationProposal; pending: boolean; submit: (event: FormEvent<HTMLFormElement>, action: SubmitAction, success: string) => void; reviseAction: Action; resolveAction: Action }) {
  // 组件以 proposalId + version 为 key 挂载：同一版本的未知结果重试复用 key，版本推进后才换 key。
  const [revisionIdempotencyKey] = useState(() => crypto.randomUUID());
  const [resolutionIdempotencyKey] = useState(() => crypto.randomUUID());
  const options = proposal.availableStrategies;
  return <>
    <form onSubmit={(event) => submit(event, reviseAction.bind(null, proposal.proposalId), "校准建议已修改。")} className="flex flex-wrap gap-2">
      {options.length ? <select name="strategy" defaultValue={options[0]} aria-label="修改策略">{options.map((strategy) => <option key={strategy} value={strategy}>{strategies[strategy]}</option>)}</select> : <p role="status">当前建议已包含可用调整。</p>}
      <input type="hidden" name="expectedVersion" value={proposal.version} />
      <input type="hidden" name="idempotencyKey" value={revisionIdempotencyKey} />
      <button className="workbench-touch-target" disabled={pending || !options.length} type="submit">修改建议</button>
    </form>
    <form onSubmit={(event) => submit(event, resolveAction.bind(null, proposal.proposalId), "校准建议已处理。")} className="flex flex-wrap gap-2">
      <input type="hidden" name="expectedVersion" value={proposal.version} />
      <input type="hidden" name="idempotencyKey" value={resolutionIdempotencyKey} />
      <button className="workbench-touch-target" disabled={pending} type="submit" name="action" value="approved">批准建议</button>
      <button className="workbench-touch-target" disabled={pending} type="submit" name="action" value="rejected">拒绝建议</button>
    </form>
  </>;
}

export function CalibrationProposals({ proposals, reviseAction, resolveAction }: { proposals: CalibrationProposal[]; reviseAction: Action; resolveAction: Action }) {
  const [pending, startTransition] = useTransition(); const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  if (!proposals.length) return null;
  const submit = (event: FormEvent<HTMLFormElement>, action: SubmitAction, success: string) => {
    event.preventDefault(); setMessage(null); setError(null);
    const formData = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.name) formData.set(submitter.name, submitter.value);
    startTransition(() => { void action(formData).then(() => setMessage(success)).catch(() => setError("操作未完成，请刷新后重试。")); });
  };
  return <section aria-labelledby="calibration-proposals-title" className="flex flex-col gap-4"><h2 id="calibration-proposals-title">校准建议</h2>{message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}{proposals.map((proposal) => <article key={proposal.proposalId} className="flex flex-col gap-3"><h3>因“{reasons[proposal.reason]}”产生的建议</h3><p>依据：{proposal.evidenceCount} 条同类忽略反馈。建议方式：{strategies[proposal.revision.strategy]}；预计会影响 {proposal.revision.impactPreview.estimatedAffectedCount} / {proposal.revision.impactPreview.sampleSize} 个样本。</p><ul aria-label="规则调整">{Object.entries(proposal.revision.impactPreview.ruleDiff).map(([key, change]) => <li key={key}>{fields[key] ?? "规则"}：{displayValue(key, change.from)} → {displayValue(key, change.to)}</li>)}</ul><p>状态：{statuses[proposal.status]}</p>{proposal.status === "pending" ? <ProposalOperationControls key={`${proposal.proposalId}:${proposal.version}`} proposal={proposal} pending={pending} submit={submit} reviseAction={reviseAction} resolveAction={resolveAction} /> : null}</article>)}</section>;
}
