"use client";

import type { JobTarget } from "@job-copilot/contracts/job-targets";
import { JOB_TRIAGE_GATES, JobTriageVersionSchema, type JobTriageVersion } from "@job-copilot/contracts/job-triage";
import { useEffect, useState } from "react";
import { createJobTriageAction } from "@/app/(workbench)/jobs/import/actions";

const verdictText = { pass: "符合资格门槛", fail: "不符合资格门槛", unknown: "待补充证据" } as const;
const deadlineText = { expired: "已过期", closing_soon: "即将截止", valid: "截止日期有效", missing: "截止日期缺失", invalid: "截止日期无效" } as const;
const gateText = { location: "地点", work_mode: "工作方式", relocation: "搬迁", salary: "薪资", seniority: "资历", education: "学历", language: "语言", work_eligibility: "工作资格", deal_breakers: "不可接受条件" } as const;

export function JobTriagePanel({ opportunityId, targets, initialVersion }: { opportunityId: string; targets: JobTarget[]; initialVersion: JobTriageVersion | null }) {
  const activeTargets = targets.filter((target) => target.state === "active");
  const [targetId, setTargetId] = useState(initialVersion?.targetId ?? activeTargets[0]?.targetId ?? "");
  const [version, setVersion] = useState(initialVersion);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    void fetch(`/api/job-opportunities/${opportunityId}/triage-versions?targetId=${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(10_000) })
      .then(async (response) => response.ok ? JobTriageVersionSchema.safeParse(await response.json()) : null)
      .then((parsed) => { if (!cancelled) setVersion(parsed?.success ? parsed.data : null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [opportunityId, targetId]);

  async function evaluate() {
    if (!targetId) return;
    setPending(true); setMessage(null);
    try {
      const result = await createJobTriageAction(opportunityId, targetId);
      if (!result.ok) throw new Error(result.message);
      setVersion(result.triage);
    } catch {
      setMessage("岗位评估暂时不可用，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return <section aria-labelledby="job-triage-title" className="job-import-panel">
    <h2 id="job-triage-title">资格门槛与粗排</h2>
    {activeTargets.length ? <div>
      <label htmlFor={`triage-target-${opportunityId}`}>用于评估的求职目标</label>
      <select id={`triage-target-${opportunityId}`} onChange={(event) => { setVersion(null); setTargetId(event.target.value); }} value={targetId}>
        {activeTargets.map((target) => <option key={target.targetId} value={target.targetId}>{target.constraints.roleFamily}</option>)}
      </select>
      <button className="workbench-touch-target" disabled={pending} onClick={() => void evaluate()} type="button">{pending ? "正在评估" : "开始资格与粗排"}</button>
    </div> : <p>请先创建一个活动求职目标，再评估岗位。</p>}
    {message && <p role="status">{message}</p>}
    {version && <div aria-live="polite" className="job-triage-results">
      <p><strong>{verdictText[version.overallVerdict]}</strong> · {deadlineText[version.deadlineStatus]} · 置信度 {Math.round(version.confidenceBasisPoints / 100)}%</p>
      <ul>{JOB_TRIAGE_GATES.map((gate) => { const result = version.gateResults[gate]; return <li key={gate}><strong>{gateText[gate]}</strong>：{verdictText[result.verdict]}
        <ul>{result.jobEvidence && <li>岗位证据：{result.jobEvidence.value}</li>}{result.candidateEvidence && <li>{result.candidateEvidence.label}：{result.candidateEvidence.value}</li>}</ul>
      </li>; })}</ul>
      {version.pendingItems.length > 0 && <ul aria-label="待补充事项">{version.pendingItems.map((item) => <li key={`${item.gate}-${item.reasonCode}`}>{item.message}</li>)}</ul>}
      {version.overallVerdict === "pass" && version.dimensionScores && <div><h3>粗排总分：{version.overallScore}/{version.threshold}</h3><p>仅用于进入后续候选或低于粗排阈值，不代表正式匹配。</p><ul><li>技术：{version.dimensionScores.technical.score}{version.dimensionScores.technical.missing.length ? "（证据待补充，按中性分计算）" : ""}</li><li>经验：{version.dimensionScores.experience.score}{version.dimensionScores.experience.missing.length ? "（证据待补充，按中性分计算）" : ""}</li><li>目标对齐：{version.dimensionScores.targetAlignment.score}{version.dimensionScores.targetAlignment.missing.length ? "（证据待补充，按中性分计算）" : ""}</li></ul></div>}
    </div>}
  </section>;
}
