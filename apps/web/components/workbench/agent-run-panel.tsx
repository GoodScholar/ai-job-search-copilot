"use client";

import {
  AgentRunDetailSchema,
  AgentRunSseEventSchema,
  ControlAgentRunResponseSchema,
  StartAgentRunResponseSchema,
  isAgentRunTerminalEvent,
  type AgentRunDetail,
  type AgentRunEventType,
  type AgentRunSseEvent,
} from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";
import type { JobTarget } from "@job-copilot/contracts/job-targets";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DiscoverySchedulePanel } from "./discovery-schedule-panel";

type TimelineEvent = {
  sequence: number;
  runVersion: number;
  eventType: AgentRunEventType;
  data: AgentRunSseEvent["data"];
};

const streamEventTypes = [
  "run.queued", "run.started", "step.started", "step.completed",
  "run.retry_scheduled", "run.completed", "run.failed",
  "run.pause_requested", "run.paused", "run.resume_requested", "run.resumed",
  "run.cancel_requested", "run.cancelled", "run.budget_updated",
] as const;

const stepLabels = {
  batch_search: "搜索岗位来源",
  fetch_details: "读取岗位详情",
  persist_results: "保存岗位结果",
  select_candidates: "选择匹配候选",
  assess_matches: "评估岗位匹配",
  create_recommendations: "生成推荐清单",
} as const;

const sourceLabels: Record<string, string> = {
  company_careers: "公司招聘官网",
};

function isDeepMatchRun(run: AgentRunDetail | null | undefined): boolean {
  return run?.workflowVersion === "deep-match-v1";
}

const failureMessages: Record<NonNullable<AgentRunDetail["failureCode"]>, string> = {
  AGENT_RUN_ADAPTER_RETRYABLE: "岗位来源暂时不可用，请稍后重新发起发现。",
  AGENT_RUN_ADAPTER_FAILED: "岗位来源返回的数据无法验证，请更换求职目标后重新发起。",
  AGENT_RUN_CONTENT_STORAGE_FAILED: "岗位证据暂时无法保存，请稍后重新发起发现。",
  AGENT_RUN_PERSIST_FAILED: "岗位结果暂时无法保存，请稍后重新发起发现。",
  AGENT_RUN_BUDGET_EXCEEDED: "本次发现超过固定处理预算，请缩小求职目标后重新发起。",
  AGENT_RUN_MODEL_RETRYABLE: "模型服务暂时不可用，请稍后重新发起发现。",
  AGENT_RUN_MODEL_AUTH_FAILED: "模型服务授权未通过，请联系支持人员后再试。",
  AGENT_RUN_MODEL_POLICY_REJECTED: "模型服务未接受本次处理，请调整求职目标后重试。",
  AGENT_RUN_MODEL_INVALID_RESPONSE: "模型服务返回无效结果，请稍后重新发起发现。",
};

function cursorKey(runId: string): string {
  return `job-copilot:agent-run:${runId}:cursor`;
}

function detailTimeline(run: AgentRunDetail | null): TimelineEvent[] {
  return run?.events.map(({ sequence, runVersion, eventType, data }) => ({ sequence, runVersion, eventType, data })) ?? [];
}

function timelineLabel(event: TimelineEvent, matching = false): string {
  switch (event.data.eventType) {
    case "run.queued": return "已排队";
    case "run.started": return matching ? "开始评估岗位匹配" : "开始发现岗位";
    case "step.started": return `正在${stepLabels[event.data.stepKey]}`;
    case "step.completed": return `已${stepLabels[event.data.stepKey]}`;
    case "run.retry_scheduled": return "正在重新尝试";
    case "run.completed": return matching ? "岗位匹配完成" : "岗位发现完成";
    case "run.failed": return matching ? "岗位匹配未完成" : "岗位发现未完成";
    case "run.pause_requested": return "等待安全暂停";
    case "run.paused": return matching ? "岗位匹配已暂停" : "岗位发现已暂停";
    case "run.resume_requested": return matching ? "正在继续岗位匹配" : "正在继续岗位发现";
    case "run.resumed": return matching ? "岗位匹配已重新排队" : "岗位发现已重新排队";
    case "run.cancel_requested": return "等待安全取消";
    case "run.cancelled": return matching ? "岗位匹配已取消" : "岗位发现已取消";
    case "run.budget_updated": return "预算使用已更新";
  }
}

function runStatusLabel(run: AgentRunDetail | null): string {
  const matching = isDeepMatchRun(run);
  const noun = matching ? "岗位匹配" : "岗位发现";
  if (!run) return "尚未开始岗位发现";
  if (run.status === "queued") return `${noun}已排队`;
  if (run.status === "running") return `${noun}进行中：${run.currentStep in stepLabels ? stepLabels[run.currentStep as keyof typeof stepLabels] : "准备中"}`;
  if (run.status === "paused") return `${noun}已暂停`;
  if (run.status === "cancelled") return `${noun}已取消`;
  if (run.status === "completed" && run.termination?.kind === "completed_with_source_issues") return `${noun}部分完成`;
  if (run.status === "completed") return matching ? `岗位匹配完成，已生成 ${run.results.length} 项推荐` : `岗位发现完成，共保存 ${run.results.length} 个岗位机会`;
  return failureMessages[run.failureCode ?? "AGENT_RUN_PERSIST_FAILED"];
}

function currentStepLabel(step: AgentRunDetail["currentStep"]): string {
  if (step in stepLabels) return stepLabels[step as keyof typeof stepLabels];
  return step === "queued" ? "等待开始" : step === "completed" ? "已完成" : step === "failed" ? "未完成" : "已取消";
}

async function fetchRunDetail(runId: string): Promise<AgentRunDetail> {
  const response = await fetch(`/api/agent-runs/${runId}`, { cache: "no-store" });
  if (!response.ok) throw new Error("detail unavailable");
  const parsed = AgentRunDetailSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("invalid detail");
  return parsed.data;
}

export function AgentRunPanel({ targets, initialRun, onInboxRefresh, refreshVersion = 0, showDiscoverySchedule = false }: {
  targets: JobTarget[];
  initialRun: AgentRunDetail | null;
  onInboxRefresh?: () => Promise<boolean>;
  refreshVersion?: number;
  showDiscoverySchedule?: boolean;
}) {
  const activeTargets = targets.filter((target) => target.state === "active");
  const initialTargetId = activeTargets.some((target) => target.targetId === initialRun?.targetId)
    ? initialRun!.targetId
    : activeTargets.find((target) => target.priority === "primary")?.targetId ?? activeTargets[0]?.targetId ?? "";
  const [selectedTargetId, setSelectedTargetId] = useState(initialTargetId);
  const [run, setRun] = useState(initialRun);
  const isLayeredPublicRun = run?.workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION;
  const [timeline, setTimeline] = useState<TimelineEvent[]>(() => detailTimeline(initialRun));
  const [message, setMessage] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const pendingRunId = useRef<string | null>(null);
  const runIsUnfinished = run != null && ["queued", "running", "paused"].includes(run.status);
  const commandIds = useRef<Record<"pause" | "resume" | "cancel", string | null>>({ pause: null, resume: null, cancel: null });
  const runRef = useRef(run);
  const mountedRef = useRef(false);
  const [pendingControls, setPendingControls] = useState<Record<"pause" | "resume" | "cancel", boolean>>({ pause: false, resume: false, cancel: false });
  const selectedTarget = targets.find((target) => target.targetId === selectedTargetId);

  const replaceRun = useCallback((next: AgentRunDetail | null) => {
    runRef.current = next;
    setRun(next);
  }, []);

  const applyRunProjection = useCallback((snapshot: Pick<AgentRunDetail, "status" | "currentStep" | "controlState" | "version">): boolean => {
    const current = runRef.current;
    if (!current) return false;
    if (snapshot.version < current.version || (current.controlState === "cancel_requested" && snapshot.controlState !== "cancel_requested" && snapshot.status !== "cancelled")) return false;
    replaceRun({ ...current, ...snapshot });
    return true;
  }, [replaceRun]);

  function applyControlSnapshot(snapshot: Pick<AgentRunDetail, "status" | "currentStep" | "controlState" | "version">): boolean {
    return applyRunProjection(snapshot);
  }

  const applyAuthoritativeDetail = useCallback((detail: AgentRunDetail): boolean => {
    const current = runRef.current;
    if (!current || current.runId !== detail.runId) return false;
    if (detail.version < current.version || (current.controlState === "cancel_requested" && detail.controlState !== "cancel_requested" && detail.status !== "cancelled")) return false;
    replaceRun(detail);
    return true;
  }, [replaceRun]);

  const refreshInboxSafely = useCallback(async (): Promise<boolean> => {
    if (!onInboxRefresh) return true;
    try {
      return await onInboxRefresh();
    } catch {
      return false;
    }
  }, [onInboxRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (refreshVersion === 0 || !runRef.current) return;
    const runId = runRef.current.runId;
    void fetchRunDetail(runId).then((detail) => {
      if (!mountedRef.current || runRef.current?.runId !== runId) return;
      if (applyAuthoritativeDetail(detail)) {
        setTimeline(detailTimeline(detail));
        setMessage("");
      }
    }).catch(() => {
      if (mountedRef.current && runRef.current?.runId === runId) {
        setMessage("运行状态已更新，但详情暂时无法读取。请刷新页面重试。");
      }
    });
  }, [applyAuthoritativeDetail, refreshVersion]);

  useEffect(() => {
    if (!run || ["paused", "completed", "failed", "cancelled"].includes(run.status)) return;
    const lastDetailSequence = run.events.at(-1)?.sequence ?? 0;
    const storedSequence = Number.parseInt(window.sessionStorage.getItem(cursorKey(run.runId)) ?? "0", 10);
    let cursor = Math.max(lastDetailSequence, Number.isSafeInteger(storedSequence) ? storedSequence : 0);
    window.sessionStorage.setItem(cursorKey(run.runId), String(cursor));
    const stream = new EventSource(`/api/agent-runs/${run.runId}/events?afterEventId=${cursor}`);
    let streamActive = true;

    const applyEvent = (type: typeof streamEventTypes[number]) => (event: Event) => {
      if (!streamActive) return;
      const messageEvent = event as MessageEvent<string>;
      let envelope: unknown;
      try { envelope = JSON.parse(messageEvent.data); } catch { return; }
      const parsed = AgentRunSseEventSchema.safeParse(envelope);
      if (!parsed.success || parsed.data.id !== messageEvent.lastEventId || parsed.data.event !== type) return;
      const sequence = Number(parsed.data.id);
      if (sequence <= cursor) return;
      cursor = sequence;
      window.sessionStorage.setItem(cursorKey(run.runId), String(sequence));
      setMessage("");
      setTimeline((events) => [...events, { sequence, runVersion: parsed.data.runVersion, eventType: parsed.data.event, data: parsed.data.data }]);
      const current = runRef.current;
      if (current) {
        const data = parsed.data.data;
        const controlState = data.eventType === "run.cancel_requested" ? "cancel_requested"
          : (data.eventType === "run.pause_requested" ? "pause_requested"
            : (data.eventType === "run.resume_requested" || data.eventType === "run.resumed" ? "none" : current.controlState));
        const applied = applyRunProjection({
          status: data.status,
          currentStep: data.currentStep,
          controlState,
          version: parsed.data.runVersion,
        });
        if (applied && data.eventType === "run.budget_updated") replaceRun({ ...runRef.current!, usage: data.usage });
      }
      if (isAgentRunTerminalEvent(type)) {
        stream.close();
        const refreshedRunId = run.runId;
        void fetchRunDetail(refreshedRunId).then((detail) => {
          if (!mountedRef.current || runRef.current?.runId !== refreshedRunId || !applyAuthoritativeDetail(detail)) return;
          setTimeline(detailTimeline(detail));
          setMessage("");
          void refreshInboxSafely().then((refreshed) => {
            if (mountedRef.current && runRef.current?.runId === refreshedRunId && !refreshed) setMessage("待处理事项暂未刷新，请刷新页面查看。");
          });
        }).catch(() => {
          if (mountedRef.current && runRef.current?.runId === refreshedRunId) setMessage("岗位发现已结束，但结果暂时无法读取。请刷新页面重试。");
        });
      }
    };
    const listeners = streamEventTypes.map((type) => [type, applyEvent(type)] as const);
    listeners.forEach(([type, listener]) => stream.addEventListener(type, listener));
    const handleError = () => { if (streamActive) setMessage("进度连接中断，正在恢复。"); };
    stream.addEventListener("error", handleError);
    return () => {
      streamActive = false;
      listeners.forEach(([type, listener]) => stream.removeEventListener(type, listener));
      stream.removeEventListener("error", handleError);
      stream.close();
    };
  }, [applyAuthoritativeDetail, applyRunProjection, refreshInboxSafely, replaceRun, run]);

  async function startRun() {
    if (!selectedTargetId || runIsUnfinished || isStarting) return;
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
      replaceRun(detail);
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

  async function controlRun(action: "pause" | "resume" | "cancel") {
    if (!run || pendingControls[action]) return;
    const commandId = commandIds.current[action] ?? crypto.randomUUID();
    commandIds.current[action] = commandId;
    setPendingControls((current) => ({ ...current, [action]: true }));
    setMessage(action === "pause" ? "等待安全暂停" : action === "cancel" ? "等待安全取消" : "正在继续岗位发现");
    try {
      const response = await fetch(`/api/agent-runs/${run.runId}/controls`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, action }),
      });
      if (!response.ok) {
        if (response.status === 409) commandIds.current[action] = null;
        setMessage(response.status === 409 ? "该运行状态已变化，请刷新后查看。" : `${action === "pause" ? "暂停" : action === "resume" ? "继续" : "取消"}请求暂时无法提交，请稍后重试。`);
        return;
      }
      const parsed = ControlAgentRunResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        setMessage("运行状态暂时无法确认，请稍后重试。");
        return;
      }
      commandIds.current[action] = null;
      if (!applyControlSnapshot(parsed.data.run)) return;
      if (parsed.data.run.status === "paused" || parsed.data.run.status === "cancelled") {
        try {
          const detail = await fetchRunDetail(run.runId);
          if (!applyAuthoritativeDetail(detail)) return;
          setTimeline(detailTimeline(detail));
          const inboxRefreshed = await refreshInboxSafely();
          if (!mountedRef.current || runRef.current?.runId !== run.runId) return;
          if (!inboxRefreshed) {
            setMessage("待处理事项暂未刷新，请刷新页面查看。");
            return;
          }
        } catch {
          setMessage("运行状态已更新，但详情暂时无法读取。请刷新页面重试。");
          return;
        }
      }
      setMessage(parsed.data.run.status === "paused" ? "岗位发现已暂停" : parsed.data.run.status === "cancelled" ? "岗位发现已取消" : action === "pause" ? "等待安全暂停" : action === "cancel" ? "等待安全取消" : "正在继续岗位发现");
    } catch {
      if (mountedRef.current) setMessage(`${action === "pause" ? "暂停" : action === "resume" ? "继续" : "取消"}请求暂时无法提交，请稍后重试。`);
    } finally {
      if (mountedRef.current) setPendingControls((current) => ({ ...current, [action]: false }));
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
    <section aria-labelledby="agent-run-title" className="workbench-ledger agent-run-panel" id="agent-run">
      <div className="workbench-ledger-heading">
        <p>岗位发现 · 运行记录</p>
        <h2 id="agent-run-title">发现新的岗位机会</h2>
      </div>
      <div className="agent-run-controls">
        <label htmlFor="agent-run-target">用于发现岗位的求职目标</label>
        <div>
          <select disabled={isStarting || runIsUnfinished} id="agent-run-target" onChange={(event) => {
            setSelectedTargetId(event.target.value);
            idempotencyKey.current = null;
            pendingRunId.current = null;
          }} value={selectedTargetId}>
            {activeTargets.map((target) => <option key={target.targetId} value={target.targetId}>{target.constraints.roleFamily} · {target.priority === "primary" ? "主目标" : "次目标"}</option>)}
          </select>
          <Button className="agent-run-start workbench-touch-target" disabled={isStarting || runIsUnfinished} onClick={startRun} size="lg" type="button">
            {isStarting ? "正在启动…" : runIsUnfinished ? "发现中…" : "发现岗位"}
          </Button>
        </div>
      </div>
      {showDiscoverySchedule && selectedTarget ? <DiscoverySchedulePanel key={selectedTarget.targetId} targetId={selectedTarget.targetId} targetState={selectedTarget.state} /> : null}
      {run ? <>
        <div className="agent-run-command-row">
          {run.status === "queued" || (run.status === "running" && run.controlState === "none") ? <button className="agent-run-action workbench-touch-target" disabled={pendingControls.pause} onClick={() => void controlRun("pause")} type="button">暂停岗位发现</button> : null}
          {run.status === "paused" || run.controlState === "pause_requested" ? <button className="agent-run-action workbench-touch-target" disabled={pendingControls.resume} onClick={() => void controlRun("resume")} type="button">继续本次岗位发现</button> : null}
          {["queued", "running", "paused"].includes(run.status) && run.controlState !== "cancel_requested" ? <button className="agent-run-action agent-run-cancel workbench-touch-target" disabled={pendingControls.cancel} onClick={() => void controlRun("cancel")} type="button">取消岗位发现</button> : null}
        </div>
        <section aria-label="本次岗位发现执行规格" className="agent-run-detail">
          <dl>
            <div><dt>求职目标</dt><dd>{run.executionSpec.targetSnapshot.constraints.roleFamily} · v{run.targetVersion}</dd></div>
            <div><dt>当前步骤</dt><dd>{currentStepLabel(run.currentStep)}</dd></div>
            <div><dt>执行流程版本</dt><dd>{run.executionSpec.workflowVersion}</dd></div>
            <div><dt>匹配规则版本</dt><dd>{run.executionSpec.ruleVersion}</dd></div>
            <div><dt>岗位来源连接版本</dt><dd>{run.executionSpec.adapter}/{run.executionSpec.adapterVersion}</dd></div>
            <div><dt>结果格式版本</dt><dd>{run.executionSpec.outputSchemaVersion}</dd></div>
            <div><dt>来源范围</dt><dd>{run.executionSpec.sourceScope.kind === "deep_match" ? (run.executionSpec.sourceScope.opportunityId ? "单岗位重新评估" : "发现后的候选岗位") : "trustedSources" in run.executionSpec.sourceScope ? `${run.executionSpec.sourceScope.trustedSources.length} 个可信来源，${run.executionSpec.sourceScope.publicDiscovery.queries.length} 个公开发现查询` : `${run.executionSpec.sourceScope.sources.length} 个固定来源`}</dd></div>
            <div><dt>允许的操作范围</dt><dd>{run.executionSpec.toolAllowlist.join("、")}</dd></div>
            <div><dt>模型</dt><dd>{isDeepMatchRun(run) && run.executionSpec.model ? `${run.executionSpec.model.provider} · ${run.executionSpec.model.model}` : "本流程未使用模型"}</dd></div>
          </dl>
        </section>
        <section aria-labelledby="agent-run-budget-title" className="agent-run-budget">
          <h3 id="agent-run-budget-title">预算使用分录</h3>
          {!run.usage.complete ? <p className="agent-run-usage-incomplete">历史消费明细不完整；以下仅展示本次运行的预算上限。</p> : null}
          <dl>
            {run.usage.complete ? <>
            <div><dt>活跃时间</dt><dd>{run.usage.activeDurationMs} / {run.executionSpec.budget.maxActiveDurationMs} ms</dd></div>
            <div><dt>来源请求</dt><dd>{run.usage.sourceRequests} / {run.executionSpec.budget.maxToolCalls} 次来源请求</dd></div>
            <div><dt>工具调用</dt><dd>{run.usage.toolCalls} / {run.executionSpec.budget.maxToolCalls} 次工具调用</dd></div>
            <div><dt>模型调用</dt><dd>{run.usage.modelCalls} / {run.executionSpec.budget.maxModelCalls} 次</dd></div>
            <div><dt>Token</dt><dd>{run.usage.totalTokens} / {run.executionSpec.budget.maxTokens} 个</dd></div>
            <div><dt>结果</dt><dd>{run.usage.results} / {run.executionSpec.budget.maxResults} 条</dd></div>
            <div><dt>尝试</dt><dd>{run.usage.attempts} / {run.executionSpec.budget.maxAttempts} 次尝试</dd></div>
            </> : <>
              <div><dt>活跃时间</dt><dd>上限：{run.executionSpec.budget.maxActiveDurationMs} ms</dd></div>
              <div><dt>来源请求</dt><dd>上限：{run.executionSpec.budget.maxToolCalls} 次来源请求</dd></div>
              <div><dt>工具调用</dt><dd>上限：{run.executionSpec.budget.maxToolCalls} 次工具调用</dd></div>
              <div><dt>模型调用</dt><dd>上限：{run.executionSpec.budget.maxModelCalls} 次</dd></div>
              <div><dt>Token</dt><dd>上限：{run.executionSpec.budget.maxTokens} 个</dd></div>
              <div><dt>结果</dt><dd>上限：{run.executionSpec.budget.maxResults} 条</dd></div>
              <div><dt>尝试</dt><dd>上限：{run.executionSpec.budget.maxAttempts} 次</dd></div>
            </>}
          </dl>
        </section>
      </> : null}
      <p aria-live="polite" className={message ? "agent-run-live agent-run-live-error" : "agent-run-live"} role="status">
        {message || runStatusLabel(run)}
      </p>
      {run?.status === "completed" && run.termination?.kind === "completed_with_source_issues" ? <p>
        {isLayeredPublicRun ? <>公开岗位发现存在待关注诊断。 <Link className="workbench-touch-target" href={`/home?runId=${run.runId}#agent-run`}>查看本次运行诊断</Link></> : <>问题来源 {("sourceChecks" in run ? run.sourceChecks : []).filter((check) => ["parser_degraded", "rate_limited", "hard_failed"].includes(check.status)).length} 个。 <Link className="workbench-touch-target" href={`/profile/targets/${run.targetId}/watchlist#source-health`}>查看来源诊断</Link></>}
      </p> : null}

      {timeline.length > 0 ? (
        <ol aria-label="岗位发现运行时间线" className="agent-run-timeline">
          {timeline.map((event) => <li data-state={event.eventType.startsWith("run.") ? event.data.status : event.eventType.endsWith("completed") ? "completed" : "running"} key={event.sequence}>
            <span aria-hidden="true">{String(event.sequence).padStart(2, "0")}</span>
            <p>{timelineLabel(event, isDeepMatchRun(run))}</p>
          </li>)}
        </ol>
      ) : null}

      {run?.status === "completed" && run.results.length > 0 ? (
        <div className="agent-run-results">
          <h3>本次发现的岗位</h3>
          <ol>
            {run.results.map((result) => <li key={result.resultId}>
              <article>
                <p>{"company" in result ? result.company ?? "公司待确认" : "已验证公开岗位来源"}</p>
                <h4>{"title" in result ? result.title ?? "岗位名称待确认" : "已验证岗位"}</h4>
                <dl>
                  {"location" in result ? <><div><dt>地点</dt><dd>{result.location ?? "未注明"}</dd></div>
                  <div><dt>发布时间</dt><dd>{result.postedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(result.postedAt)) : "未注明"}</dd></div></> : null}
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
