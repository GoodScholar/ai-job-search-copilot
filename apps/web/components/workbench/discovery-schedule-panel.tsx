"use client";

import { JobDiscoveryScheduleResponseSchema, type JobDiscoveryScheduleResponse } from "@job-copilot/contracts/job-discovery-schedules";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

type Props = { targetId: string; targetState: "active" | "inactive" };
type LoadState = { targetId: string; kind: "loading" } | { targetId: string; kind: "error" } | { targetId: string; kind: "ready"; value: JobDiscoveryScheduleResponse };

function dailyTimeError(value: string): string {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? "" : "请输入有效的北京时间（HH:mm）。";
}

function scheduleStatus(input: JobDiscoveryScheduleResponse, targetState: Props["targetState"]) {
  if (targetState !== "active") return { text: "该求职目标已停用，不能启用每日检查。", canEnable: false };
  if (input.sourceSupport.status === "policy_required") return { text: "待接入：需允许 boards-api.greenhouse.io", canEnable: false };
  if (input.sourceSupport.status === "unsupported") return { text: "待接入", canEnable: false };
  return { text: `可每日检查 ${input.sourceSupport.supportedSourceCount} 个岗位来源`, canEnable: true };
}

export function DiscoverySchedulePanel({ targetId, targetState }: Props) {
  const [loaded, setLoaded] = useState<LoadState>(() => ({ targetId, kind: "loading" }));
  const generation = useRef(0);
  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    void fetch(`/api/job-targets/${targetId}/discovery-schedule`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("schedule unavailable");
      const parsed = JobDiscoveryScheduleResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error("invalid schedule");
      if (generation.current === requestGeneration) setLoaded({ targetId, kind: "ready", value: parsed.data });
    }).catch(() => {
      if (!controller.signal.aborted && generation.current === requestGeneration) setLoaded({ targetId, kind: "error" });
    });
    return () => controller.abort();
  }, [targetId]);
  const visible = loaded.targetId === targetId ? loaded : { targetId, kind: "loading" } as const;
  return <section aria-labelledby="discovery-schedule-title" className="discovery-schedule-panel">
    <div className="discovery-schedule-heading"><div><p>自动检查 · 计划</p><h3 id="discovery-schedule-title">每天检查新岗位</h3></div></div>
    {visible.kind === "loading" ? <p aria-live="polite" className="discovery-schedule-live">正在读取每日检查…</p> : null}
    {visible.kind === "error" ? <p aria-live="polite" className="discovery-schedule-live">每日检查暂时无法读取，请稍后重试。</p> : null}
    {visible.kind === "ready" ? <DiscoveryScheduleForm key={`${targetId}:${visible.value.schedule?.version ?? 0}`} initialSchedule={visible.value} targetId={targetId} targetState={targetState} /> : null}
  </section>;
}

function DiscoveryScheduleForm({ targetId, targetState, initialSchedule }: Props & { initialSchedule: JobDiscoveryScheduleResponse }) {
  const [saved, setSaved] = useState(initialSchedule);
  const [dailyTime, setDailyTime] = useState(initialSchedule.schedule?.dailyTime ?? "09:30");
  const [desiredState, setDesiredState] = useState<"enabled" | "disabled">(initialSchedule.schedule?.state ?? "disabled");
  const [message, setMessage] = useState("");
  const [timeError, setTimeError] = useState("");
  const [targetBlocked, setTargetBlocked] = useState(false);
  const [pending, startTransition] = useTransition();
  const status = targetBlocked ? { text: "该求职目标已停用，不能启用每日检查。", canEnable: false } : scheduleStatus(saved, targetState);
  const canDisable = status.canEnable || saved.schedule?.state === "enabled";
  const canSave = status.canEnable || canDisable;
  const intendedState = status.canEnable ? desiredState : "disabled";
  function save() {
    if (pending) return;
    const invalidTime = dailyTimeError(dailyTime);
    if (invalidTime) { setTimeError(invalidTime); return; }
    setTimeError("");
    startTransition(async () => {
      setMessage("");
      try {
        const response = await fetch(`/api/job-targets/${targetId}/discovery-schedule`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: saved.schedule?.version ?? 0, state: intendedState, dailyTime }) });
        const payload = await response.json().catch(() => null);
        const code = typeof payload === "object" && payload !== null && "code" in payload && typeof payload.code === "string" ? payload.code : null;
        if (!response.ok) {
          if (code === "SOURCE_POLICY_REQUIRED") setSaved((current) => ({ ...current, sourceSupport: { status: "policy_required", message: "需允许 boards-api.greenhouse.io" } }));
          if (code === "NO_SUPPORTED_SOURCE") setSaved((current) => ({ ...current, sourceSupport: { status: "unsupported" } }));
          if (code === "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE") setTargetBlocked(true);
          setMessage(code === "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" ? "每日检查已在其他位置更新，请刷新后重试。" : code === "SOURCE_POLICY_REQUIRED" ? "待接入：需允许 boards-api.greenhouse.io" : code === "PROFILE_UNAVAILABLE" ? "请先完善求职档案。" : code === "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE" ? "该求职目标已停用，不能启用每日检查。" : code === "ACCOUNT_RUN_POLICY_WINDOW_CLOSED" ? "该检查时间不在账户允许的后台时段内，请调整检查时间或账户运行策略。" : code === "NO_SUPPORTED_SOURCE" ? "待接入" : "每日检查暂时无法保存，请稍后重试。");
          return;
        }
        const parsed = JobDiscoveryScheduleResponseSchema.safeParse(payload);
        if (!parsed.success) { setMessage("每日检查暂时无法确认，请稍后重试。"); return; }
        setSaved(parsed.data); setDesiredState(parsed.data.schedule?.state ?? "disabled"); setMessage(parsed.data.schedule?.state === "enabled" ? "每日检查已保存。" : "每日检查已停用。");
      } catch { setMessage("网络暂时不可用，未保存每日检查。请稍后重试。"); }
    });
  }
  return <>
    <p aria-live="polite" className="discovery-schedule-support" data-state={status.canEnable ? "ready" : "pending"}>{status.text}</p>
    <ol aria-label="每日检查时间轨" className="discovery-schedule-rail"><li><span>状态</span><strong>{saved.schedule?.state === "enabled" ? "已启用" : "已停用"}</strong></li><li><span>北京时间</span><strong>{dailyTime}（Asia/Shanghai）</strong></li><li><span>下一次检查</span><strong>{saved.schedule?.nextRunAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(saved.schedule.nextRunAt)) : "启用后安排"}</strong></li></ol>
    <div className="discovery-schedule-controls"><div><label htmlFor={`daily-time-${targetId}`}>每日检查时间（北京时间 / Asia/Shanghai）</label><input aria-describedby={`daily-time-help-${targetId}${timeError ? ` daily-time-error-${targetId}` : ""}`} aria-invalid={Boolean(timeError)} disabled={pending || !status.canEnable} id={`daily-time-${targetId}`} onChange={(event) => { setDailyTime(event.target.value); setTimeError(""); }} type="time" value={dailyTime} /><p id={`daily-time-help-${targetId}`}>每天在这个时间检查已接入的公开岗位来源。</p>{timeError ? <p id={`daily-time-error-${targetId}`}>{timeError}</p> : null}</div><div className="discovery-schedule-actions" role="group" aria-label="每日检查状态"><Button className="workbench-touch-target" disabled={pending || !status.canEnable} onClick={() => setDesiredState("enabled")} size="lg" type="button" variant={intendedState === "enabled" ? "default" : "outline"}>启用</Button><Button className="workbench-touch-target" disabled={pending || !canDisable} onClick={() => setDesiredState("disabled")} size="lg" type="button" variant={intendedState === "disabled" ? "secondary" : "outline"}>停用</Button><Button className="workbench-touch-target" disabled={pending || !canSave} onClick={save} size="lg" type="button">{pending ? "正在保存…" : "保存每日检查"}</Button></div></div>
    {message ? <p aria-live="polite" className="discovery-schedule-live" role="status">{message}</p> : null}
  </>;
}
