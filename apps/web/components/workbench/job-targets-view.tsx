"use client";

import { JobTargetOverviewSchema, type JobTarget, type JobTargetConstraints, type JobTargetOverview } from "@job-copilot/contracts/job-targets";
import { useState, type FormEvent } from "react";

type TargetDraft = { roleFamily: string; seniority: string; locations: string; workModes: JobTargetConstraints["workModes"]; relocation: JobTargetConstraints["relocation"]; minimumSalary: string; maximumSalary: string; salaryPeriod: "month" | "year"; salaryCurrency: string; industries: string; excludedCompanies: string; excludedIndustries: string; excludeOutsourcing: boolean; excludeDispatch: boolean; excludeHeadhunter: boolean; otherDealBreakers: string };
const emptyDraft: TargetDraft = { roleFamily: "", seniority: "", locations: "", workModes: [], relocation: "unknown", minimumSalary: "", maximumSalary: "", salaryPeriod: "month", salaryCurrency: "CNY", industries: "", excludedCompanies: "", excludedIndustries: "", excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, otherDealBreakers: "" };
const workModeLabels = { onsite: "线下办公", hybrid: "混合办公", remote: "远程办公" } as const;
const relocationLabels = { unknown: "暂不确定", not_willing: "不接受", willing: "接受", conditional: "视条件而定" } as const;

function listValue(value: string): string[] { return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean); }
function draftFrom(constraints: JobTargetConstraints): TargetDraft {
  return { roleFamily: constraints.roleFamily, seniority: constraints.seniority ?? "", locations: constraints.locations.join(", "), workModes: constraints.workModes, relocation: constraints.relocation, minimumSalary: constraints.salary?.minimum?.toString() ?? "", maximumSalary: constraints.salary?.maximum?.toString() ?? "", salaryPeriod: constraints.salary?.period ?? "month", salaryCurrency: constraints.salary?.currency ?? "CNY", industries: constraints.industries.join(", "), excludedCompanies: constraints.dealBreakers.excludedCompanies.join(", "), excludedIndustries: constraints.dealBreakers.excludedIndustries.join(", "), excludeOutsourcing: constraints.dealBreakers.excludeOutsourcing, excludeDispatch: constraints.dealBreakers.excludeDispatch, excludeHeadhunter: constraints.dealBreakers.excludeHeadhunter, otherDealBreakers: constraints.dealBreakers.other.join(", ") };
}
function constraintsFrom(draft: TargetDraft): JobTargetConstraints {
  const minimum = draft.minimumSalary.trim() ? Number(draft.minimumSalary) : null;
  const maximum = draft.maximumSalary.trim() ? Number(draft.maximumSalary) : null;
  return { roleFamily: draft.roleFamily.trim(), seniority: draft.seniority.trim() || null, locations: listValue(draft.locations), workModes: draft.workModes, relocation: draft.relocation, salary: minimum === null && maximum === null ? null : { minimum, maximum, period: draft.salaryPeriod, currency: draft.salaryCurrency.trim().toUpperCase() }, industries: listValue(draft.industries), dealBreakers: { excludedCompanies: listValue(draft.excludedCompanies), excludedIndustries: listValue(draft.excludedIndustries), excludeOutsourcing: draft.excludeOutsourcing, excludeDispatch: draft.excludeDispatch, excludeHeadhunter: draft.excludeHeadhunter, other: listValue(draft.otherDealBreakers) } };
}
function targetStatus(target: JobTarget): string { return target.state === "active" ? target.priority === "primary" ? "主目标" : "次目标" : "已停用"; }

export function JobTargetsView({ initialOverview }: { initialOverview: JobTargetOverview }) {
  const [overview, setOverview] = useState(initialOverview);
  const [draft, setDraft] = useState<TargetDraft>(emptyDraft);
  const [priority, setPriority] = useState<"primary" | "secondary">("primary");
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const editingTarget = overview.targets.find((target) => target.targetId === editingTargetId) ?? null;
  const otherActiveTargets = overview.targets.filter((target) => target.state === "active" && target.targetId !== editingTargetId);
  const primaryUnavailable = otherActiveTargets.some((target) => target.priority === "primary");
  const secondaryUnavailable = otherActiveTargets.filter((target) => target.priority === "secondary").length >= 2;
  const selectedPriority = editingTarget ? priority : priority === "primary" && primaryUnavailable ? secondaryUnavailable ? null : "secondary" : priority === "secondary" && secondaryUnavailable ? primaryUnavailable ? null : "primary" : priority;
  const noAvailableSlot = !editingTarget && selectedPriority === null;
  function updateDraft<Key extends keyof TargetDraft>(key: Key, value: TargetDraft[Key]) { setDraft((previous) => ({ ...previous, [key]: value })); }
  function selectSuggestion(roleFamily: string) { setDraft((previous) => ({ ...previous, roleFamily })); setEditingTargetId(null); setMessage(""); }
  function editTarget(target: JobTarget) { setDraft(draftFrom(target.constraints)); setPriority(target.priority); setEditingTargetId(target.targetId); setMessage(""); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (noAvailableSlot) { setMessage("主目标和两个次目标均已设置。如需新增，请先停用或修改已有目标。"); return; }
    const constraints = constraintsFrom(draft);
    if (!constraints.roleFamily || !Number.isFinite(constraints.salary?.minimum ?? 0) || !Number.isFinite(constraints.salary?.maximum ?? 0)) { setMessage("请检查求职目标中的必填内容和薪资范围。"); return; }
    setMessage(""); setIsSaving(true);
    const target = editingTargetId ? overview.targets.find((item) => item.targetId === editingTargetId) : null;
    const path = target ? `/api/job-targets/${target.targetId}/revisions` : "/api/job-targets";
    const body = target ? { expectedVersion: target.version, priority, constraints } : { priority: selectedPriority!, constraints };
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { setMessage(response.status === 409 ? "目标已在其他位置更新，请刷新后重试。" : "暂时无法保存求职目标，请稍后重试。"); return; }
      const nextOverview = JobTargetOverviewSchema.safeParse(await response.json());
      if (!nextOverview.success) { setMessage("暂时无法保存求职目标，请稍后重试。"); return; }
      setOverview(nextOverview.data); setEditingTargetId(null); setDraft(emptyDraft); setPriority("primary"); setMessage("求职目标已保存。");
    } catch { setMessage("暂时无法保存求职目标，请稍后重试。"); } finally { setIsSaving(false); }
  }
  async function deactivate(target: JobTarget) {
    setMessage(""); setIsSaving(true);
    try {
      const response = await fetch(`/api/job-targets/${target.targetId}/deactivations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: target.version }) });
      if (!response.ok) { setMessage(response.status === 409 ? "目标已在其他位置更新，请刷新后重试。" : "暂时无法停用求职目标，请稍后重试。"); return; }
      const nextOverview = JobTargetOverviewSchema.safeParse(await response.json());
      if (!nextOverview.success) { setMessage("暂时无法停用求职目标，请稍后重试。"); return; }
      setOverview(nextOverview.data); if (editingTargetId === target.targetId) { setEditingTargetId(null); setDraft(emptyDraft); } setMessage("求职目标已停用。");
    } catch { setMessage("暂时无法停用求职目标，请稍后重试。"); } finally { setIsSaving(false); }
  }
  return <main className="container profile-main job-targets-main">
    <section aria-labelledby="job-targets-title" className="profile-intro"><p className="workbench-kicker">求职画像 · 目标确认</p><h1 id="job-targets-title">确认你的求职目标</h1><p>设置一个主目标与最多两个次目标；系统会据此筛选岗位机会，但不会代表你执行外部行动。</p></section>
    <section aria-labelledby="job-target-suggestions-title" className="job-targets-section"><h2 id="job-target-suggestions-title">候选方向</h2><p>候选方向只会预填表单。请核对建议依据并手动确认后再保存。</p><ol className="job-target-suggestion-list">{overview.suggestions.slice(0, 5).map((suggestion) => <li key={suggestion.suggestionId}><article><h3>{suggestion.roleFamily}</h3><p>{suggestion.rationale}</p><strong>建议依据</strong><ul>{suggestion.evidence.map((evidence) => <li key={`${evidence.factId}-${evidence.revisionId}`}>{evidence.label}</li>)}</ul><button className="workbench-touch-target" onClick={() => selectSuggestion(suggestion.roleFamily)} type="button">使用 {suggestion.roleFamily} 建议</button></article></li>)}</ol></section>
    <section aria-labelledby="job-target-form-title" className="job-targets-section"><h2 id="job-target-form-title">{editingTarget ? `修改 ${editingTarget.constraints.roleFamily}` : "手动确认求职目标"}</h2>{noAvailableSlot ? <p className="profile-status" role="status">主目标和两个次目标均已设置。如需新增，请先停用或修改已有目标。</p> : null}<form className="job-target-form" onSubmit={submit}>
      <fieldset><legend>目标优先级</legend><label><input checked={selectedPriority === "primary"} disabled={primaryUnavailable} name="priority" onChange={() => setPriority("primary")} type="radio" value="primary" /> 主目标</label><label><input checked={selectedPriority === "secondary"} disabled={secondaryUnavailable} name="priority" onChange={() => setPriority("secondary")} type="radio" value="secondary" /> 次目标</label></fieldset>
      <label>角色族<input onChange={(event) => updateDraft("roleFamily", event.target.value)} required value={draft.roleFamily} /></label><label>资历级别<input onChange={(event) => updateDraft("seniority", event.target.value)} value={draft.seniority} /></label><label>意向地点（用逗号分隔）<input onChange={(event) => updateDraft("locations", event.target.value)} value={draft.locations} /></label>
      <label>工作方式<select aria-label="工作方式" multiple onChange={(event) => updateDraft("workModes", Array.from(event.currentTarget.selectedOptions, (option) => option.value as JobTargetConstraints["workModes"][number]))} value={draft.workModes}>{Object.entries(workModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>是否接受搬迁<select onChange={(event) => updateDraft("relocation", event.target.value as TargetDraft["relocation"])} value={draft.relocation}>{Object.entries(relocationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="job-target-salary-fields"><label>最低薪资<input inputMode="numeric" min="0" onChange={(event) => updateDraft("minimumSalary", event.target.value)} type="number" value={draft.minimumSalary} /></label><label>最高薪资<input inputMode="numeric" min="0" onChange={(event) => updateDraft("maximumSalary", event.target.value)} type="number" value={draft.maximumSalary} /></label><label>薪资周期<select onChange={(event) => updateDraft("salaryPeriod", event.target.value as TargetDraft["salaryPeriod"])} value={draft.salaryPeriod}><option value="month">月</option><option value="year">年</option></select></label><label>薪资币种<select onChange={(event) => updateDraft("salaryCurrency", event.target.value)} value={draft.salaryCurrency}><option value="CNY">CNY</option><option value="USD">USD</option><option value="HKD">HKD</option></select></label></div>
      <label>意向行业（用逗号分隔）<input onChange={(event) => updateDraft("industries", event.target.value)} value={draft.industries} /></label><fieldset><legend>不可接受条件</legend><label>不接受的公司（用逗号分隔）<input onChange={(event) => updateDraft("excludedCompanies", event.target.value)} value={draft.excludedCompanies} /></label><label>不接受的行业（用逗号分隔）<input onChange={(event) => updateDraft("excludedIndustries", event.target.value)} value={draft.excludedIndustries} /></label><label><input checked={draft.excludeOutsourcing} onChange={(event) => updateDraft("excludeOutsourcing", event.target.checked)} type="checkbox" /> 不接受外包</label><label><input checked={draft.excludeDispatch} onChange={(event) => updateDraft("excludeDispatch", event.target.checked)} type="checkbox" /> 不接受派遣</label><label><input checked={draft.excludeHeadhunter} onChange={(event) => updateDraft("excludeHeadhunter", event.target.checked)} type="checkbox" /> 不接受猎头</label><label>其他不可接受条件（用逗号分隔）<input onChange={(event) => updateDraft("otherDealBreakers", event.target.value)} value={draft.otherDealBreakers} /></label></fieldset>
      <button className="profile-upload-button workbench-touch-target" disabled={isSaving || noAvailableSlot} type="submit">{editingTarget ? "保存修改" : noAvailableSlot ? "保存求职目标" : selectedPriority === "primary" ? "保存主目标" : "保存次目标"}</button>
    </form>{message ? <p aria-live="polite" className="profile-status" role="status">{message}</p> : null}</section>
    <section aria-labelledby="job-target-history-title" className="job-targets-section"><h2 id="job-target-history-title">已确认目标与历史</h2>{overview.targets.length ? <ol className="job-target-history-list">{overview.targets.map((target) => <li key={target.targetId}><article><div><strong>{target.constraints.roleFamily}</strong><span>{targetStatus(target)}</span></div><p>版本 {target.version} · {target.constraints.seniority ?? "未限定资历"}</p><p>{target.constraints.locations.length ? target.constraints.locations.join("、") : "地点未限定"} · {target.constraints.workModes.map((mode) => workModeLabels[mode]).join("、") || "工作方式未限定"}</p>{target.state === "active" ? <div className="profile-fact-actions"><button aria-label={`修改 ${target.constraints.roleFamily}`} className="workbench-touch-target" onClick={() => editTarget(target)} type="button">修改</button><button aria-label={`停用 ${target.constraints.roleFamily}`} className="workbench-touch-target" disabled={isSaving} onClick={() => void deactivate(target)} type="button">停用</button></div> : null}</article></li>)}</ol> : <p className="profile-next-step">尚未保存求职目标。</p>}</section>
  </main>;
}
