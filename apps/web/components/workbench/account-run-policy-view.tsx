"use client";

import {
  AccountRunPolicyCommandSchema,
  AccountRunControlResponseSchema,
  AccountRunControlStateSchema,
  AccountRunPolicyHistorySchema,
  type AccountRunControlState,
  AccountRunPolicyResponseSchema,
  type AccountRunPolicyResponse,
  type AccountRunPolicyRevision,
  type AccountRunPolicySettings,
} from "@job-copilot/contracts/account-run-policies";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type BudgetKind = "publicDiscovery" | "deepMatch";
type BudgetField = keyof AccountRunPolicySettings["budgets"][BudgetKind];

const discoveryLabels = {
  trustedSourceLimit: "每次运行来源数量",
  publicQueryLimit: "公开查询次数上限",
  verificationCandidateLimit: "验证候选数上限",
} as const;

const budgetFields: ReadonlyArray<{ key: BudgetField; label: string; unit?: "minutes" }> = [
  { key: "maxActiveDurationMs", label: "最长运行时长", unit: "minutes" },
  { key: "maxAttempts", label: "最多尝试次数" },
  { key: "maxToolCalls", label: "最多工具调用次数" },
  { key: "maxResults", label: "最多生成推荐数" },
  { key: "maxModelCalls", label: "最多模型调用次数" },
  { key: "maxTokens", label: "最多模型处理量" },
];

function formatShanghai(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function displayBudget(value: number, unit?: "minutes"): number {
  return unit === "minutes" ? value / 60_000 : value;
}

function budgetLabel(kind: BudgetKind): string {
  return kind === "publicDiscovery" ? "公开岗位发现" : "深度匹配";
}

function budgetFieldLabel(kind: BudgetKind, field: BudgetField): string {
  if (field === "maxResults") return kind === "publicDiscovery" ? "保留岗位结果数" : "最多生成推荐数";
  return budgetFields.find((item) => item.key === field)?.label ?? "该预算";
}

function revisionSetting(revision: AccountRunPolicyRevision): string {
  const { discovery, backgroundWindow } = revision.settings;
  return `可信来源上限：${discovery.trustedSourceLimit}；公开查询：${discovery.publicQueryLimit}；后台窗口：${backgroundWindow.start}–${backgroundWindow.end}`;
}

function revisionDetails(revision: AccountRunPolicyRevision) {
  const { discovery, budgets, backgroundWindow } = revision.settings;
  return <details><summary>查看完整设置</summary><div className="run-policy-revision-details">
    <p>每次运行来源数量：{discovery.trustedSourceLimit}</p><p>公开查询次数上限：{discovery.publicQueryLimit}</p><p>验证候选数上限：{discovery.verificationCandidateLimit}</p><p>公开查询：{discovery.enabledProviders.includes("anysearch") ? "已启用" : "未启用"}</p>
    {(["publicDiscovery", "deepMatch"] as const).map((kind) => budgetFields.map((field) => <p key={`${kind}-${field.key}`}>{budgetLabel(kind)}{budgetFieldLabel(kind, field.key)}：{displayBudget(budgets[kind][field.key], field.unit)}{field.unit === "minutes" ? " 分钟" : ""}</p>))}
    <p>后台运行时间：{backgroundWindow.start}–{backgroundWindow.end}（Asia/Shanghai）</p>
  </div></details>;
}

export function AccountRunPolicyView({ initialControl = null, initialPolicy }: { initialControl?: AccountRunControlState | null; initialPolicy: AccountRunPolicyResponse }) {
  const [policy, setPolicy] = useState(initialPolicy);
  const [settings, setSettings] = useState(initialPolicy.effective);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const [history, setHistory] = useState<AccountRunPolicyRevision[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [control, setControl] = useState(initialControl);
  const [controlUnavailable, setControlUnavailable] = useState(initialControl === null);
  const [controlling, setControlling] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const pendingControlCommand = useRef<{ commandId: string; expectedVersion: number; action: "stop" | "release" } | null>(null);
  const { defaults, hardLimits } = policy.system;

  function fieldLabel(key: string): string {
    const discoveryKey = key.replace("discovery.", "") as keyof typeof discoveryLabels;
    if (discoveryKey in discoveryLabels) return discoveryLabels[discoveryKey];
    const [kind, field] = key.replace("budgets.", "").split(".") as [BudgetKind, BudgetField];
    return key.startsWith("budgets.") ? budgetFieldLabel(kind, field) : "该设置";
  }

  function hardMaximum(key: string): number | null {
    const discoveryKey = key.replace("discovery.", "") as keyof typeof hardLimits.discovery;
    if (key.startsWith("discovery.") && discoveryKey in discoveryLabels) return hardLimits.discovery[discoveryKey] as number;
    const [budgetKind, budgetField] = key.replace("budgets.", "").split(".") as [BudgetKind, BudgetField];
    if (key.startsWith("budgets.") && budgetKind in hardLimits.budgets) return hardLimits.budgets[budgetKind][budgetField];
    return null;
  }

  function updateDiscovery(key: keyof typeof settings.discovery, value: number) {
    setSettings((current) => ({ ...current, discovery: { ...current.discovery, [key]: value } }));
    setFieldErrors({});
  }

  function updateBudget(kind: BudgetKind, key: BudgetField, value: number, unit?: "minutes") {
    setSettings((current) => ({ ...current, budgets: { ...current.budgets, [kind]: { ...current.budgets[kind], [key]: unit === "minutes" ? value * 60_000 : value } } }));
    setFieldErrors({});
  }

  function validationError(key: string, maximum: number | null, fallback = "请检查输入的运行策略。") {
    if (key.startsWith("backgroundWindow.")) return "开始和结束时间不能相同，请调整后再保存。";
    const displayedMaximum = key.endsWith(".maxActiveDurationMs") && maximum !== null ? `${displayBudget(maximum, "minutes")} 分钟` : maximum;
    return maximum === null ? fallback : `${fieldLabel(key)}不得超过 ${displayedMaximum}，请调整后再保存。`;
  }

  function applyServerError(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null || !("code" in payload) || typeof payload.code !== "string") return false;
    if (payload.code === "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID") {
      setFieldErrors({ "backgroundWindow.start": "开始和结束时间不能相同，请调整后再保存。", "backgroundWindow.end": "开始和结束时间不能相同，请调整后再保存。" });
      return true;
    }
    if (payload.code !== "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED" || !("issues" in payload) || !Array.isArray(payload.issues)) return false;
    const issue = payload.issues[0];
    if (typeof issue !== "object" || issue === null || !("path" in issue) || !Array.isArray(issue.path)) return false;
    const key = issue.path.slice(1).join(".");
    const maximum = "maximum" in issue && typeof issue.maximum === "number" ? issue.maximum : hardMaximum(key);
    setFieldErrors({ [key]: validationError(key, maximum) });
    return true;
  }

  async function save() {
    const command = { expectedVersion: policy.revision.revisionNumber, settings };
    const validation = AccountRunPolicyCommandSchema.safeParse(command);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      const key = issue.path.slice(1).join(".");
      const maximum = hardMaximum(key);
      const error = validationError(key, maximum);
      setFieldErrors(key.startsWith("backgroundWindow.") ? { "backgroundWindow.start": error, "backgroundWindow.end": error } : { [key]: error });
      setMessage("");
      return;
    }
    setSaving(true);
    setMessage("");
    setFieldErrors({});
    setHasConflict(false);
    try {
      const response = await fetch("/api/account/run-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && typeof payload === "object" && payload !== null && "code" in payload && payload.code === "ACCOUNT_RUN_POLICY_VERSION_CONFLICT") {
        setMessage("策略已在其他位置更新，请重新读取后再保存。");
        setHasConflict(true);
        return;
      }
      if (applyServerError(payload)) return;
      const parsed = AccountRunPolicyResponseSchema.safeParse(payload);
      if (!response.ok || !parsed.success) {
        setMessage("暂时无法保存运行策略，请稍后重试。");
        return;
      }
      setPolicy(parsed.data);
      setSettings(parsed.data.effective);
      setMessage("运行策略已保存。");
    } catch {
      setMessage("暂时无法保存运行策略，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    setReloading(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/run-policy", { cache: "no-store" });
      const parsed = AccountRunPolicyResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        setMessage("暂时无法重新读取运行策略，请稍后重试。");
        return;
      }
      setPolicy(parsed.data);
      setSettings(parsed.data.effective);
      setHasConflict(false);
      setFieldErrors({});
      setMessage("已重新读取最新运行策略。");
    } catch {
      setMessage("暂时无法重新读取运行策略，请稍后重试。");
    } finally {
      setReloading(false);
    }
  }

  async function loadHistory() {
    setLoadingHistory(true);
    try {
      const response = await fetch("/api/account/run-policy/history", { cache: "no-store" });
      const parsed = AccountRunPolicyHistorySchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        setMessage("暂时无法读取修订历史，请稍后重试。");
        return;
      }
      setHistory(parsed.data.revisions);
    } catch {
      setMessage("暂时无法读取修订历史，请稍后重试。");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function refreshControl(): Promise<AccountRunControlState | null> {
    try {
      const response = await fetch("/api/account/run-policy/control", { cache: "no-store" });
      const parsed = AccountRunControlStateSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) {
        setControlUnavailable(true);
        setControlMessage("运行控制暂不可用");
        return null;
      }
      setControl(parsed.data);
      setControlUnavailable(false);
      return parsed.data;
    } catch {
      setControlUnavailable(true);
      setControlMessage("运行控制暂不可用");
      return null;
    }
  }

  async function controlAllRuns() {
    if (!control || controlling) return;
    const command = pendingControlCommand.current ?? {
      commandId: crypto.randomUUID(), expectedVersion: control.controlVersion,
      action: control.stoppedAt === null ? "stop" as const : "release" as const,
    };
    pendingControlCommand.current = command;
    setControlling(true);
    setControlMessage("");
    try {
      const response = await fetch("/api/account/run-policy/controls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        pendingControlCommand.current = null;
        setControlMessage("运行控制已在其他位置更新，已重新读取当前状态。");
        await refreshControl();
        return;
      }
      if (!response.ok || !AccountRunControlResponseSchema.safeParse(payload).success) {
        setControlMessage("暂时无法更新运行控制，请稍后重试。");
        return;
      }
      pendingControlCommand.current = null;
      const refreshed = await refreshControl();
      if (refreshed) {
        setControlMessage(refreshed.stoppedAt === null ? "已解除全局停止。旧运行需逐个继续，错过的计划不会补跑" : "已停止全部运行。");
      }
    } catch {
      setControlMessage("暂时无法更新运行控制，请稍后重试。");
    } finally {
      setControlling(false);
    }
  }

  return <main className="container profile-main">
    <section className="profile-intro"><p className="workbench-kicker">求职画像 · 运行策略</p><h1>账户运行策略</h1><p>系统硬上限保护每次运行。你可以保存更保守的额度；手动运行不受后台窗口限制。</p></section>
    <section aria-labelledby="account-run-control-title" className="job-targets-section">
      <h2 id="account-run-control-title">账户运行控制</h2>
      <p>停止后将阻止新的运行和外部动作，正在运行的任务会在安全检查点暂停；已发出的请求可能仍产生费用。</p>
      {control?.stoppedAt !== null && control ? <p>已停止新动作，正在运行的任务将在安全检查点暂停。已发出的请求可能仍产生费用</p> : null}
      {control?.stoppedAt !== null && control ? <p>全局停止已生效。解除不会自动恢复旧运行，旧运行需逐个继续，错过的计划不会补跑</p> : <p>解除全局停止只开放未来新运行，不会恢复旧运行或补跑错过的计划。</p>}
      <div className="run-policy-actions"><Button className="workbench-touch-target" disabled={controlUnavailable || !control || controlling} onClick={() => void controlAllRuns()} size="lg" type="button" variant="outline">{controlling ? "正在更新…" : !control || control.stoppedAt === null ? "停止全部运行" : "解除全局停止"}</Button></div>
      {controlMessage ? <p aria-live="polite" className="run-policy-status" role="status">{controlMessage}</p> : null}
    </section>
    <section aria-labelledby="run-policy-comparison-title" className="job-targets-section">
      <h2 id="run-policy-comparison-title">当前策略对照</h2>
      <div aria-label="当前策略对照表，可横向滚动" className="run-policy-table-wrap" tabIndex={0}><table><thead><tr><th scope="col">设置</th><th scope="col">系统默认</th><th scope="col">硬上限</th><th scope="col">你的设置</th><th scope="col">最终生效</th></tr></thead><tbody>
        {(Object.keys(discoveryLabels) as Array<keyof typeof discoveryLabels>).map((key) => <tr key={key}><th scope="row">{discoveryLabels[key]}</th><td>{defaults.discovery[key]}</td><td>{hardLimits.discovery[key]}</td><td>{policy.userSettings?.discovery[key] ?? "系统默认"}</td><td>{policy.effective.discovery[key]}</td></tr>)}
        {(["publicDiscovery", "deepMatch"] as const).map((kind) => budgetFields.map((field) => <tr key={`${kind}-${field.key}`}><th scope="row">{budgetLabel(kind)} · {budgetFieldLabel(kind, field.key)}{field.unit === "minutes" ? "（分钟）" : ""}</th><td>{displayBudget(defaults.budgets[kind][field.key], field.unit)}</td><td>{displayBudget(hardLimits.budgets[kind][field.key], field.unit)}</td><td>{policy.userSettings ? displayBudget(policy.userSettings.budgets[kind][field.key], field.unit) : "系统默认"}</td><td>{displayBudget(policy.effective.budgets[kind][field.key], field.unit)}</td></tr>))}
        <tr><th scope="row">公开查询</th><td>已启用</td><td>可启用</td><td>{policy.userSettings ? (policy.userSettings.discovery.enabledProviders.includes("anysearch") ? "已启用" : "未启用") : "系统默认"}</td><td>{policy.effective.discovery.enabledProviders.includes("anysearch") ? "已启用" : "未启用"}</td></tr>
        <tr><th scope="row">后台运行时间</th><td>{defaults.backgroundWindow.start}–{defaults.backgroundWindow.end}</td><td>全天可用</td><td>{policy.userSettings ? `${policy.userSettings.backgroundWindow.start}–${policy.userSettings.backgroundWindow.end}` : "系统默认"}</td><td>{policy.effective.backgroundWindow.start}–{policy.effective.backgroundWindow.end}</td></tr>
      </tbody></table></div>
    </section>
    <section aria-labelledby="run-policy-settings-title" className="job-targets-section">
      <h2 id="run-policy-settings-title">调整运行策略</h2><p>当前修订：{policy.revision.revisionNumber}{policy.revision.isSystemBaseline ? "（账户初始基线）" : ""}</p><p>以下设置只会收紧账户运行策略，不能超过系统硬上限。</p>
      <fieldset className="run-policy-fieldset"><legend>公开岗位发现</legend><div className="run-policy-field-grid">
        {(Object.keys(discoveryLabels) as Array<keyof typeof discoveryLabels>).map((key) => {
          const fieldKey = `discovery.${key}`;
          const error = fieldErrors[fieldKey];
          const labels = { trustedSourceLimit: "每次运行来源数量", publicQueryLimit: "每次运行最多执行公开查询", verificationCandidateLimit: "每次运行最多验证候选" };
          return <label key={key}>{labels[key]}<input aria-describedby={error ? `${fieldKey}-error` : undefined} aria-invalid={Boolean(error)} max={hardLimits.discovery[key]} min="0" onChange={(event) => updateDiscovery(key, Number(event.target.value))} type="number" value={settings.discovery[key]} />{error ? <span id={`${fieldKey}-error`}>{error}</span> : null}</label>;
        })}
        <label className="run-policy-checkbox"><input checked={settings.discovery.enabledProviders.includes("anysearch")} onChange={(event) => setSettings((current) => ({ ...current, discovery: { ...current.discovery, enabledProviders: event.target.checked ? ["anysearch"] : [] } }))} type="checkbox" />启用 AnySearch 公开查询</label>
      </div></fieldset>
      <fieldset className="run-policy-fieldset"><legend>每次运行预算</legend><div className="run-policy-budget-grid">
        {(["publicDiscovery", "deepMatch"] as const).map((kind) => <section aria-label={budgetLabel(kind)} key={kind}><h3>{budgetLabel(kind)}</h3><div className="run-policy-field-grid">
          {budgetFields.map((field) => {
            const fieldKey = `budgets.${kind}.${field.key}`;
            const error = fieldErrors[fieldKey];
            return <label key={field.key}>{budgetLabel(kind)}{budgetFieldLabel(kind, field.key)}{field.unit === "minutes" ? "（分钟）" : ""}<input aria-describedby={error ? `${fieldKey}-error` : undefined} aria-invalid={Boolean(error)} max={displayBudget(hardLimits.budgets[kind][field.key], field.unit)} min="0" onChange={(event) => updateBudget(kind, field.key, Number(event.target.value), field.unit)} type="number" value={displayBudget(settings.budgets[kind][field.key], field.unit)} />{error ? <span id={`${fieldKey}-error`}>{error}</span> : null}</label>;
          })}
        </div></section>)}
      </div></fieldset>
      <fieldset className="run-policy-fieldset"><legend>后台运行时间</legend><p>使用北京时间（Asia/Shanghai）。可以跨日，例如 23:00 到次日 02:00。</p><div className="run-policy-field-grid run-policy-time-grid">
        <label>后台允许开始时间<input aria-describedby={fieldErrors["backgroundWindow.start"] ? "background-window-error" : undefined} aria-invalid={Boolean(fieldErrors["backgroundWindow.start"])} onChange={(event) => setSettings((current) => ({ ...current, backgroundWindow: { ...current.backgroundWindow, start: event.target.value } }))} type="time" value={settings.backgroundWindow.start} /></label>
        <label>后台允许结束时间<input aria-describedby={fieldErrors["backgroundWindow.end"] ? "background-window-error" : undefined} aria-invalid={Boolean(fieldErrors["backgroundWindow.end"])} onChange={(event) => setSettings((current) => ({ ...current, backgroundWindow: { ...current.backgroundWindow, end: event.target.value } }))} type="time" value={settings.backgroundWindow.end} /></label>
      </div>{fieldErrors["backgroundWindow.end"] ? <p id="background-window-error">{fieldErrors["backgroundWindow.end"]}</p> : null}</fieldset>
      <div className="run-policy-actions"><Button className="workbench-touch-target" disabled={saving || reloading} onClick={() => void save()} size="lg" type="button">{saving ? "正在保存…" : "保存运行策略"}</Button>{hasConflict ? <Button className="workbench-touch-target" disabled={reloading} onClick={() => void reload()} size="lg" type="button" variant="outline">{reloading ? "正在重新读取…" : "重新读取最新策略"}</Button> : null}<Button className="workbench-touch-target" disabled={loadingHistory} onClick={() => void loadHistory()} size="lg" type="button" variant="outline">{loadingHistory ? "正在读取历史…" : "查看修订历史"}</Button></div>
      {message ? <p aria-live="polite" className="run-policy-status" role="status">{message}</p> : null}
    </section>
    {history ? <section aria-labelledby="run-policy-history-title" className="job-targets-section"><h2 id="run-policy-history-title">修订历史</h2><ol className="run-policy-history">{history.map((revision) => <li key={revision.revisionNumber}><strong>修订 {revision.revisionNumber}{revision.isSystemBaseline ? "（账户初始基线）" : ""}</strong><time dateTime={revision.createdAt}>{formatShanghai(revision.createdAt)}</time><p>{revisionSetting(revision)}</p>{revisionDetails(revision)}</li>)}</ol></section> : null}
  </main>;
}
