"use client";

import {
  AgentRunDetailSchema,
  AgentRunSseEventSchema,
  StartAgentRunResponseSchema,
  type AgentRunDetail,
  type AgentRunEventTypeSchema,
  type AgentRunSseEvent,
} from "@job-copilot/contracts/agent-runs";
import type { JobTarget } from "@job-copilot/contracts/job-targets";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";

type TimelineEvent = {
  sequence: number;
  eventType: z.infer<typeof AgentRunEventTypeSchema>;
  data: AgentRunSseEvent["data"];
};

const streamEventTypes = [
  "run.queued", "run.started", "step.started", "step.completed",
  "run.retry_scheduled", "run.completed", "run.failed",
] as const;

const stepLabels = {
  batch_search: "搜索岗位来源",
  fetch_details: "读取岗位详情",
  persist_results: "保存岗位结果",
} as const;

const sourceLabels: Record<string, string> = {
  company_careers: "公司招聘官网",
};

const failureMessages: Record<NonNullable<AgentRunDetail["failureCode"]>, string> = {
  AGENT_RUN_ADAPTER_RETRYABLE: "岗位来源暂时不可用，请稍后重新发起发现。",
  AGENT_RUN_ADAPTER_FAILED: "岗位来源返回的数据无法验证，请更换求职目标后重新发起。",
  AGENT_RUN_CONTENT_STORAGE_FAILED: "岗位证据暂时无法保存，请稍后重新发起发现。",
  AGENT_RUN_PERSIST_FAILED: "岗位结果暂时无法保存，请稍后重新发起发现。",
  AGENT_RUN_BUDGET_EXCEEDED: "本次发现超过固定处理预算，请缩小求职目标后重新发起。",
};

function cursorKey(runId: string): string {
  return `job-copilot:agent-run:${runId}:cursor`;
}

function detailTimeline(run: AgentRunDetail | null): TimelineEvent[] {
  return run?.events.map(({ sequence, eventType, data }) => ({ sequence, eventType, data })) ?? [];
}

function timelineLabel(event: TimelineEvent): string {
  switch (event.data.eventType) {
    case "run.queued": return "已排队";
    case "run.started": return "开始发现岗位";
    case "step.started": return `正在${stepLabels[event.data.stepKey]}`;
    case "step.completed": return `已${stepLabels[event.data.stepKey]}`;
    case "run.retry_scheduled": return "正在重新尝试";
    case "run.completed": return "岗位发现完成";
    case "run.failed": return "岗位发现未完成";
  }
}

function runStatusLabel(run: AgentRunDetail | null): string {
  if (!run) return "尚未开始岗位发现";
  if (run.status === "queued") return "岗位发现已排队";
  if (run.status === "running") return `岗位发现进行中：${run.currentStep in stepLabels ? stepLabels[run.currentStep as keyof typeof stepLabels] : "准备中"}`;
  if (run.status === "completed") return `岗位发现完成，共保存 ${run.results.length} 个岗位机会`;
  return failureMessages[run.failureCode ?? "AGENT_RUN_PERSIST_FAILED"];
}

async function fetchRunDetail(runId: string): Promise<AgentRunDetail> {
  const response = await fetch(`/api/agent-runs/${runId}`, { cache: "no-store" });
  if (!response.ok) throw new Error("detail unavailable");
  const parsed = AgentRunDetailSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("invalid detail");
  return parsed.data;
}

export function AgentRunPanel({ targets, initialRun }: { targets: JobTarget[]; initialRun: AgentRunDetail | null }) {
  const activeTargets = targets.filter((target) => target.state === "active");
  const initialTargetId = activeTargets.some((target) => target.targetId === initialRun?.targetId)
    ? initialRun!.targetId
    : activeTargets.find((target) => target.priority === "primary")?.targetId ?? activeTargets[0]?.targetId ?? "";
  const [selectedTargetId, setSelectedTargetId] = useState(initialTargetId);
  const [run, setRun] = useState(initialRun);
  const [timeline, setTimeline] = useState<TimelineEvent[]>(() => detailTimeline(initialRun));
  const [message, setMessage] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const pendingRunId = useRef<string | null>(null);
  const runIsActive = run?.status === "queued" || run?.status === "running";

  useEffect(() => {
    if (!run || run.status === "completed" || run.status === "failed") return;
    const lastDetailSequence = run.events.at(-1)?.sequence ?? 0;
    const storedSequence = Number.parseInt(window.sessionStorage.getItem(cursorKey(run.runId)) ?? "0", 10);
    let cursor = Math.max(lastDetailSequence, Number.isSafeInteger(storedSequence) ? storedSequence : 0);
    window.sessionStorage.setItem(cursorKey(run.runId), String(cursor));
    const stream = new EventSource(`/api/agent-runs/${run.runId}/events?afterEventId=${cursor}`);
    let current = true;

    const applyEvent = (type: typeof streamEventTypes[number]) => (event: Event) => {
      if (!current) return;
      const messageEvent = event as MessageEvent<string>;
      let data: unknown;
      try { data = JSON.parse(messageEvent.data); } catch { return; }
      const parsed = AgentRunSseEventSchema.safeParse({ id: messageEvent.lastEventId, event: type, data });
      if (!parsed.success) return;
      const sequence = Number(parsed.data.id);
      if (sequence <= cursor) return;
      cursor = sequence;
      window.sessionStorage.setItem(cursorKey(run.runId), String(sequence));
      setMessage("");
      setTimeline((events) => [...events, { sequence, eventType: parsed.data.event, data: parsed.data.data }]);
      if (type === "run.completed" || type === "run.failed") {
        stream.close();
        void fetchRunDetail(run.runId).then((detail) => {
          if (!current) return;
          setRun(detail);
          setTimeline(detailTimeline(detail));
          setMessage("");
        }).catch(() => {
          if (current) setMessage("岗位发现已结束，但结果暂时无法读取。请刷新页面重试。");
        });
      }
    };
    const listeners = streamEventTypes.map((type) => [type, applyEvent(type)] as const);
    listeners.forEach(([type, listener]) => stream.addEventListener(type, listener));
    const handleError = () => { if (current) setMessage("进度连接中断，正在恢复。"); };
    stream.addEventListener("error", handleError);
    return () => {
      current = false;
      listeners.forEach(([type, listener]) => stream.removeEventListener(type, listener));
      stream.removeEventListener("error", handleError);
      stream.close();
    };
  }, [run]);

  async function startRun() {
    if (!selectedTargetId || runIsActive || isStarting) return;
    idempotencyKey.current ??= crypto.randomUUID();
    setIsStarting(true);
    setMessage("");
    let createdRunId = pendingRunId.current;
    try {
      if (!createdRunId) {
        const response = await fetch("/api/agent-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetId: selectedTargetId, idempotencyKey: idempotencyKey.current }),
        });
        if (!response.ok) {
          setMessage("岗位发现暂时无法启动，请稍后重试。");
          return;
        }
        const started = StartAgentRunResponseSchema.safeParse(await response.json().catch(() => null));
        if (!started.success) {
          setMessage("岗位发现暂时无法启动，请稍后重试。");
          return;
        }
        createdRunId = started.data.runId;
        pendingRunId.current = createdRunId;
      }
      const detail = await fetchRunDetail(createdRunId);
      setRun(detail);
      setTimeline(detailTimeline(detail));
      pendingRunId.current = null;
      idempotencyKey.current = null;
    } catch {
      setMessage(createdRunId
        ? "运行已创建，正在恢复状态。请稍后重试。"
        : "岗位发现暂时无法启动，请稍后重试。");
    } finally {
      setIsStarting(false);
    }
  }

  if (activeTargets.length === 0) {
    return (
      <section aria-labelledby="agent-run-title" className="workbench-ledger agent-run-panel">
        <div className="workbench-ledger-heading">
          <p>岗位发现 · 尚未启用</p>
          <h2 id="agent-run-title">先确认求职目标</h2>
        </div>
        <div className="workbench-ledger-row">
          <div><h3>告诉 Copilot 你在找什么</h3><p>确认岗位方向、地点和不可接受条件后，才能开始发现岗位。</p></div>
          <Link className="workbench-ledger-link workbench-touch-target" href="/profile/targets">确认求职目标</Link>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="agent-run-title" className="workbench-ledger agent-run-panel">
      <div className="workbench-ledger-heading">
        <p>岗位发现 · 运行记录</p>
        <h2 id="agent-run-title">发现新的岗位机会</h2>
      </div>
      <div className="agent-run-controls">
        <label htmlFor="agent-run-target">用于发现岗位的求职目标</label>
        <div>
          <select disabled={isStarting || runIsActive} id="agent-run-target" onChange={(event) => {
            setSelectedTargetId(event.target.value);
            idempotencyKey.current = null;
            pendingRunId.current = null;
          }} value={selectedTargetId}>
            {activeTargets.map((target) => <option key={target.targetId} value={target.targetId}>{target.constraints.roleFamily} · {target.priority === "primary" ? "主目标" : "次目标"}</option>)}
          </select>
          <button className="agent-run-start workbench-touch-target" disabled={isStarting || runIsActive} onClick={startRun} type="button">
            {isStarting ? "正在启动…" : runIsActive ? "发现中…" : "发现岗位"}
          </button>
        </div>
      </div>
      <p aria-live="polite" className={message ? "agent-run-live agent-run-live-error" : "agent-run-live"} role="status">
        {message || runStatusLabel(run)}
      </p>

      {timeline.length > 0 ? (
        <ol aria-label="岗位发现运行时间线" className="agent-run-timeline">
          {timeline.map((event) => <li data-state={event.eventType.startsWith("run.") ? event.data.status : event.eventType.endsWith("completed") ? "completed" : "running"} key={event.sequence}>
            <span aria-hidden="true">{String(event.sequence).padStart(2, "0")}</span>
            <p>{timelineLabel(event)}</p>
          </li>)}
        </ol>
      ) : null}

      {run?.status === "completed" && run.results.length > 0 ? (
        <div className="agent-run-results">
          <h3>本次发现的岗位</h3>
          <ol>
            {run.results.map((result) => <li key={result.resultId}>
              <article>
                <p>{result.company ?? "公司待确认"}</p>
                <h4>{result.title ?? "岗位名称待确认"}</h4>
                <dl>
                  <div><dt>地点</dt><dd>{result.location ?? "未注明"}</dd></div>
                  <div><dt>发布时间</dt><dd>{result.postedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(result.postedAt)) : "未注明"}</dd></div>
                  <div><dt>来源</dt><dd>{sourceLabels[result.sourceType] ?? "公开岗位来源"}</dd></div>
                </dl>
              </article>
            </li>)}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
