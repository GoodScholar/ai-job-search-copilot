"use client";

import { JobDiscoveryScheduleResponseSchema, type JobDiscoveryScheduleResponse } from "@job-copilot/contracts/job-discovery-schedules";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  targetId: string;
  targetState: "active" | "inactive";
  initialSchedule: JobDiscoveryScheduleResponse;
};

function scheduleStatus(input: JobDiscoveryScheduleResponse, targetState: Props["targetState"]): { text: string; canEnable: boolean } {
  if (targetState !== "active") return { text: "该求职目标已停用，不能启用每日检查。", canEnable: false };
  if (input.sourceSupport.status === "policy_required") return { text: "待接入：需允许 boards-api.greenhouse.io", canEnable: false };
  if (input.sourceSupport.status === "unsupported") return { text: "待接入", canEnable: false };
  return { text: `可每日检查 ${input.sourceSupport.supportedSourceCount} 个岗位来源`, canEnable: true };
}

export function DiscoverySchedulePanel({ targetId, targetState, initialSchedule }: Props) {
  const [saved, setSaved] = useState(initialSchedule);
  const [dailyTime, setDailyTime] = useState(initialSchedule.schedule?.dailyTime ?? "09:30");
  const [desiredState, setDesiredState] = useState<"enabled" | "disabled">(initialSchedule.schedule?.state ?? "disabled");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const status = scheduleStatus(saved, targetState);
  const currentlyEnabled = saved.schedule?.state === "enabled";
  const intendedState = status.canEnable ? desiredState : "disabled";

  function save() {
    if (pending || !status.canEnable && intendedState === "enabled") return;
    startTransition(async () => {
      setMessage("");
      try {
        const response = await fetch(`/api/job-targets/${targetId}/discovery-schedule`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: saved.schedule?.version ?? 0, state: intendedState, dailyTime }),
        });
        if (response.status === 409) {
          setMessage("每日检查已在其他位置更新，请刷新后的版本后重试。");
          return;
        }
        if (!response.ok) {
          setMessage("每日检查暂时无法保存，请稍后重试。");
          return;
        }
        const parsed = JobDiscoveryScheduleResponseSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) {
          setMessage("每日检查暂时无法确认，请稍后重试。");
          return;
        }
        setSaved(parsed.data);
        setDesiredState(parsed.data.schedule?.state ?? "disabled");
        setMessage(parsed.data.schedule?.state === "enabled" ? "每日检查已保存。" : "每日检查已停用。");
      } catch {
        setMessage("网络暂时不可用，未保存每日检查。请稍后重试。");
      }
    });
  }

  return (
    <section aria-labelledby="discovery-schedule-title" className="discovery-schedule-panel">
      <div className="discovery-schedule-heading">
        <div>
          <p>自动检查 · 计划</p>
          <h3 id="discovery-schedule-title">每天检查新岗位</h3>
        </div>
        <p aria-live="polite" className="discovery-schedule-support" data-state={status.canEnable ? "ready" : "pending"}>{status.text}</p>
      </div>
      <ol aria-label="每日检查时间轨" className="discovery-schedule-rail">
        <li><span>状态</span><strong>{currentlyEnabled ? "已启用" : "已停用"}</strong></li>
        <li><span>北京时间</span><strong>{dailyTime}（Asia/Shanghai）</strong></li>
        <li><span>下一次检查</span><strong>{saved.schedule?.nextRunAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(saved.schedule.nextRunAt)) : "启用后安排"}</strong></li>
      </ol>
      <div className="discovery-schedule-controls">
        <div>
          <label htmlFor={`daily-time-${targetId}`}>每日检查时间（北京时间 / Asia/Shanghai）</label>
          <input aria-describedby={`daily-time-help-${targetId}`} aria-invalid={Boolean(message)} disabled={pending || !status.canEnable} id={`daily-time-${targetId}`} onChange={(event) => setDailyTime(event.target.value)} type="time" value={dailyTime} />
          <p id={`daily-time-help-${targetId}`}>每天在这个时间检查已接入的公开岗位来源。</p>
        </div>
        <div className="discovery-schedule-actions" role="group" aria-label="每日检查状态">
          <Button className="workbench-touch-target" disabled={pending || !status.canEnable} onClick={() => setDesiredState("enabled")} size="lg" type="button" variant={intendedState === "enabled" ? "default" : "outline"}>启用</Button>
          <Button className="workbench-touch-target" disabled={pending} onClick={() => setDesiredState("disabled")} size="lg" type="button" variant={intendedState === "disabled" ? "secondary" : "outline"}>停用</Button>
          <Button className="workbench-touch-target" disabled={pending || (!status.canEnable && intendedState === "enabled")} onClick={save} size="lg" type="button">{pending ? "正在保存…" : "保存每日检查"}</Button>
        </div>
      </div>
      <p aria-live="polite" className="discovery-schedule-live" role="status">{message}</p>
    </section>
  );
}
