"use client";

import { RecommendationRunPreparationSchema, RecommendationRunSchema, type RecommendationRun, type RecommendationRunPreparation } from "@job-copilot/contracts/recommendation-runs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const pollingIntervalMs = 15_000;
const stages = [["discovery", "发现岗位"], ["qualification", "资格筛选"], ["coarse_ranking", "初步排序"], ["deep_matching", "深度匹配"], ["result_publication", "发布结果"]] as const;
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const failureActionLinks = {
  review_account_run_policy: { href: "/profile/run-policy", label: "查看运行设置" },
  review_profile: { href: "/profile", label: "完善求职画像" },
  review_primary_target: { href: "/profile/targets", label: "查看求职目标" },
  review_source_health: { href: "/profile/targets", label: "查看来源状态" },
  run_model_diagnostic: { href: "/profile/model-connection", label: "检查模型连接" },
} as const;
const preflightActionLinks = {
  review_account_run_policy: { href: "/profile/run-policy", label: "查看运行设置" },
  review_job_targets: { href: "/profile/targets", label: "查看求职目标" },
  review_profile: { href: "/profile", label: "完善求职画像" },
  review_source_capabilities: { href: "/profile/targets", label: "查看来源设置" },
  review_source_health: { href: "/profile/targets", label: "查看来源状态" },
  run_model_diagnostic: { href: "/profile/model-connection", label: "检查模型连接" },
} as const;
const coverageLossLabels = {
  TRUSTED_SOURCE_UNAVAILABLE: "可信来源暂不可用", PUBLIC_DISCOVERY_UNAVAILABLE: "公开发现暂不可用", SOURCE_HEALTH_DEGRADED: "来源健康度下降",
  SOURCE_CAPABILITY_UNAVAILABLE: "来源能力暂不可用", VERIFICATION_FAILED: "验证未通过", DISCOVERY_BUDGET_EXCEEDED: "发现预算已用尽",
} as const;
type Action = "pause" | "resume" | "cancel";

type Props = { initialRun: RecommendationRun | null; initialPreparation: RecommendationRunPreparation | null; unavailable?: boolean; onRunChanged?: () => void; };

function stageStatusLabel(status: RecommendationRun["stages"][number]["status"]) {
  return ({ pending: "等待开始", running: "正在进行", completed: "已完成", failed: "未完成", cancelled: "已取消" })[status];
}
function runStatus(run: RecommendationRun | null) {
  if (!run) return "尚未开始今日发现";
  if (run.status === "queued") return "已提交，等待开始";
  if (run.status === "running") return "正在完成今日发现";
  if (run.status === "paused") return "本次推荐已暂停";
  if (run.status === "completed") return run.result?.kind === "no_recommendations" ? "本次暂无推荐" : "本次推荐已准备完成";
  if (run.status === "cancelled") return "本次推荐已取消";
  return run.failure?.summary ?? "本次推荐未完成";
}
async function readRun(runId: string, signal: AbortSignal): Promise<RecommendationRun> {
  const response = await fetch(`/api/recommendation-runs/${runId}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("recommendation run unavailable");
  const parsed = RecommendationRunSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("invalid recommendation run");
  return parsed.data;
}

export function RecommendationRunPanel({ initialRun, initialPreparation, unavailable = false, onRunChanged }: Props) {
  const [run, setRun] = useState(initialRun);
  const [preparation, setPreparation] = useState(initialPreparation);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const idempotencyKey = useRef<string | null>(null);
  const commandIds = useRef<Partial<Record<Action, string>>>({});
  const authoritativeRunId = useRef(initialRun?.runId ?? null);
  const authorityGeneration = useRef(0);
  const readGeneration = useRef(0);
  const readAbortController = useRef<AbortController | null>(null);
  const startOperation = useRef(0);
  const controlOperation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authorityGeneration.current += 1;
      readAbortController.current?.abort();
    };
  }, []);
  useEffect(() => {
    const rootChanged = authoritativeRunId.current !== initialRun?.runId;
    authoritativeRunId.current = initialRun?.runId ?? null;
    if (initialRun?.status === "paused") commandIds.current.pause = undefined;
    if (initialRun?.status === "running") commandIds.current.resume = undefined;
    const generation = ++authorityGeneration.current;
    readGeneration.current += 1;
    readAbortController.current?.abort();
    queueMicrotask(() => {
      if (!mounted.current || authorityGeneration.current !== generation) return;
      setRun(initialRun);
      setPreparation(initialPreparation);
      if (rootChanged) {
        commandIds.current = {};
        idempotencyKey.current = null;
        setConfirmationOpen(false);
        setPendingAction(null);
        setPendingStart(false);
      }
    });
  }, [initialPreparation, initialRun]);
  const adoptRun = useCallback((next: RecommendationRun | null) => {
    authoritativeRunId.current = next?.runId ?? null;
    authorityGeneration.current += 1;
    readGeneration.current += 1;
    readAbortController.current?.abort();
    setRun(next);
  }, []);
  const runId = run?.runId;
  const currentRunStatus = run?.status;
  const refreshRun = useCallback(async () => {
    if (!runId) return false;
    const generation = ++readGeneration.current;
    const controller = new AbortController();
    readAbortController.current?.abort();
    readAbortController.current = controller;
    try {
      const next = await readRun(runId, controller.signal);
      if (mounted.current && readGeneration.current === generation && authoritativeRunId.current === runId) {
        if (next.status === "paused") commandIds.current.pause = undefined;
        if (next.status === "running") commandIds.current.resume = undefined;
        setRun(next);
        setMessage("");
        return true;
      }
    } catch {
      if (!controller.signal.aborted && mounted.current && readGeneration.current === generation && authoritativeRunId.current === runId) {
        setMessage("运行状态暂时无法读取，请稍后刷新页面重试。");
      }
    } finally {
      if (readAbortController.current === controller) readAbortController.current = null;
    }
    return false;
  }, [runId]);
  useEffect(() => {
    if (!runId || !currentRunStatus || terminalStatuses.has(currentRunStatus)) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const begin = () => {
      if (document.visibilityState !== "visible" || timer) return;
      void refreshRun();
      timer = setInterval(() => void refreshRun(), pollingIntervalMs);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibilityChange = () => document.visibilityState === "visible" ? begin() : stop();
    begin();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [currentRunStatus, refreshRun, runId]);

  const refreshAuthoritativeState = useCallback(async () => {
    const generation = authorityGeneration.current;
    const [preparationResponse, latestResponse] = await Promise.all([
      fetch("/api/recommendation-runs/preparation", { cache: "no-store" }), fetch("/api/recommendation-runs/latest", { cache: "no-store" }),
    ]);
    if (!preparationResponse.ok || !latestResponse.ok) return false;
    const nextPreparation = RecommendationRunPreparationSchema.safeParse(await preparationResponse.json().catch(() => null));
    const latestPayload = await latestResponse.json().catch(() => null);
    const latestRun = latestPayload && typeof latestPayload === "object" && !Array.isArray(latestPayload) && Object.keys(latestPayload).length === 1 && "run" in latestPayload
      ? latestPayload.run === null ? { success: true as const, data: null } : RecommendationRunSchema.safeParse(latestPayload.run)
      : { success: false as const };
    if (mounted.current && authorityGeneration.current === generation && nextPreparation.success && latestRun.success) {
      setPreparation(nextPreparation.data);
      adoptRun(latestRun.data);
      return true;
    }
    return false;
  }, [adoptRun]);
  const preflight = preparation?.preflight ?? null;
  const accountStopped = preflight?.items.some((item) => item.code === "ACCOUNT_RUN_POLICY_BLOCKED") ?? false;
  const blocked = unavailable || preflight === null || preflight.status === "blocked";
  const blockedAction = preflight?.items.find((item) => item.severity === "blocking")?.suggestedActions[0];
  const blockedLink = blockedAction ? preflightActionLinks[blockedAction] : null;
  const unfinished = run !== null && !terminalStatuses.has(run.status);
  async function start(confirmed = false) {
    if (blocked || unfinished || pendingStart || !preflight) return;
    if (preflight.status === "ready_with_warnings" && !confirmed) { setConfirmationOpen(true); return; }
    idempotencyKey.current ??= crypto.randomUUID();
    const generation = authorityGeneration.current;
    const operation = ++startOperation.current;
    setPendingStart(true); setMessage("");
    try {
      const response = await fetch("/api/recommendation-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: idempotencyKey.current, warningFingerprint: preflight.status === "ready_with_warnings" ? preflight.warningFingerprint : null }) });
      const payload = await response.json().catch(() => null);
      const parsed = RecommendationRunSchema.safeParse(payload && typeof payload === "object" && "run" in payload ? payload.run : null);
      const stopped = payload && typeof payload === "object" && "code" in payload && payload.code === "ACCOUNT_RUN_STOPPED";
      if (parsed.success && [200, 201].includes(response.status) && mounted.current && authorityGeneration.current === generation) { adoptRun(parsed.data); setConfirmationOpen(false); idempotencyKey.current = null; onRunChanged?.(); return; }
      if (response.status === 409) {
        const refreshed = await refreshAuthoritativeState().catch(() => false);
        if (mounted.current) {
          setConfirmationOpen(false);
          setMessage(stopped ? "账户已停止全部运行，请先在运行设置中解除全局停止。" : refreshed ? "启动条件已变化，已读取最新准备状态。" : "启动条件已变化，但暂时无法读取最新准备状态，请稍后刷新页面重试。");
        }
        return;
      }
      if (mounted.current && authorityGeneration.current === generation) setMessage(stopped ? "账户已停止全部运行，请先在运行设置中解除全局停止。" : "今日发现暂时无法启动，请稍后重试。");
    } catch { if (mounted.current && authorityGeneration.current === generation) setMessage("今日发现暂时无法启动，请稍后重试。"); }
    finally { if (mounted.current && startOperation.current === operation) setPendingStart(false); }
  }
  async function control(action: Action) {
    if (!run || pendingAction) return;
    if (authoritativeRunId.current !== run.runId) return;
    const commandId = commandIds.current[action] ?? crypto.randomUUID(); commandIds.current[action] = commandId; setPendingAction(action); setMessage("");
    const generation = authorityGeneration.current;
    const operation = ++controlOperation.current;
    const controlledRunId = run.runId;
    try {
      const response = await fetch(`/api/recommendation-runs/${run.runId}/controls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, action }) });
      const payload = await response.json().catch(() => null);
      const parsed = RecommendationRunSchema.safeParse(payload && typeof payload === "object" && "run" in payload ? payload.run : null);
      if (parsed.success && response.ok && mounted.current && authorityGeneration.current === generation && authoritativeRunId.current === controlledRunId) { commandIds.current[action] = undefined; adoptRun(parsed.data); onRunChanged?.(); return; }
      if (response.status === 409) {
        const refreshed = await refreshRun();
        const stopped = payload && typeof payload === "object" && "code" in payload && payload.code === "ACCOUNT_RUN_STOPPED";
        if (mounted.current && authorityGeneration.current === generation && authoritativeRunId.current === controlledRunId) setMessage(stopped ? "账户已停止全部运行，请先在运行设置中解除全局停止。" : refreshed ? "运行状态已变化，已读取最新状态。" : "运行状态已变化，但暂时无法读取最新状态，请稍后刷新页面重试。"); return;
      }
      if (mounted.current && authorityGeneration.current === generation && authoritativeRunId.current === controlledRunId) setMessage("本次操作暂时无法提交，请稍后重试。");
    } catch { if (mounted.current && authorityGeneration.current === generation && authoritativeRunId.current === controlledRunId) setMessage("本次操作暂时无法提交，请稍后重试。"); }
    finally { if (mounted.current && controlOperation.current === operation) setPendingAction(null); }
  }
  const resultHref = run?.result ? `/recommendations?runId=${run.runId}&resultId=${run.result.resultId}#recommendation-result` : null;
  const emptyEvidence = run?.result?.kind === "no_recommendations" ? run.result.evidence : null;
  return <section aria-labelledby="recommendation-run-title" className="workbench-ledger recommendation-run-panel" id="recommendation-run">
    <div className="workbench-ledger-heading"><h2 id="recommendation-run-title">开始今日完整推荐</h2></div>
    {unavailable ? <p className="recommendation-run-message">推荐准备状态暂时无法读取，请稍后刷新页面重试。</p> : <>
      {preparation && <div className="recommendation-run-summary"><p>主目标：{preparation.target?.roleFamily ?? "尚未设置"}</p><p>本次将检查 {preparation.sourceScope.trustedSourceCount} 个可信来源和 {preparation.sourceScope.publicQueryCount} 条公开查询。</p><p>账户运行策略版本：{preparation.accountPolicyRevisionNumber}</p><p>发现预算：最多 {preparation.budgets.discovery.maxResults} 条岗位；深度匹配预算：最多 {preparation.budgets.deepMatch.maxResults} 条。</p></div>}
      {preflight?.status === "blocked" && <div className="recommendation-run-notice"><p>{accountStopped ? "账户运行策略当前阻止启动。" : "请先处理启动前的阻塞项。"}</p>{blockedLink && <Link className="workbench-touch-target recommendation-run-link" href={blockedLink.href}>{blockedLink.label}</Link>}</div>}
      <div className="recommendation-run-start"><Button className="workbench-touch-target" disabled={blocked || unfinished || pendingStart} onClick={() => void start()} size="lg" type="button">{pendingStart ? "正在开始…" : unfinished ? "今日发现进行中" : "开始今日发现"}</Button></div>
      {confirmationOpen && <div className="recommendation-run-notice recommendation-run-warning"><p>{preflight?.items.filter((item) => item.severity === "warning").map((item) => `${item.summary}：${item.impact}`).join("；")}</p><Button className="workbench-touch-target" onClick={() => void start(true)} size="lg" type="button">我已了解，开始今日发现</Button></div>}
    </>}
    <ol aria-label="完整推荐阶段" className="recommendation-run-stages">{stages.map(([key, label]) => {
      const stage = run?.stages.find((candidate) => candidate.key === key);
      return <li aria-current={run?.currentStage === key ? "step" : undefined} data-status={stage?.status ?? "pending"} key={key}><h3>{label}</h3><p>{stage ? stageStatusLabel(stage.status) : "等待开始"}</p></li>;
    })}</ol>
    <p aria-live="polite" className={message ? "recommendation-run-live" : "recommendation-run-live is-empty"} role="status">{message || runStatus(run)}</p>
    {message.includes("账户已停止") && <Link className="workbench-touch-target recommendation-run-link" href="/profile/run-policy">查看运行设置</Link>}
    {emptyEvidence && <div className="recommendation-run-notice"><div><p>已检查 {emptyEvidence.sourceCoverage.checkedBranchCount} 个分支，可信覆盖 {emptyEvidence.sourceCoverage.credibleBranchCount} 个，发现 {emptyEvidence.discovery.discoveredJobCount} 条岗位。</p><p>资格筛选：淘汰 {emptyEvidence.qualification.rejectedCount} 条，信息不足 {emptyEvidence.qualification.insufficientInformationCount} 条，已过期 {emptyEvidence.qualification.expiredCount} 条。</p><p>粗排：低于阈值 {emptyEvidence.coarseRanking.belowThresholdCount} 条，规则排除 {emptyEvidence.coarseRanking.ruleExcludedCount} 条，超出上限 {emptyEvidence.coarseRanking.candidateLimitExcludedCount} 条。</p><p>深度匹配：质量不足 {emptyEvidence.deepMatching.qualityInsufficientCount} 条。</p>{emptyEvidence.coverageLosses.length ? <p>{emptyEvidence.coverageLosses.map((loss) => `${coverageLossLabels[loss.code]}：${loss.affectedCount}`).join("；")}</p> : <p>无覆盖损失。</p>}</div>{emptyEvidence.suggestedActions.map((action) => action === "restart_discovery" ? <Button className="workbench-touch-target" key={action} onClick={() => void start()} type="button">重新开始今日发现</Button> : <Link className="workbench-touch-target recommendation-run-link" href={failureActionLinks[action].href} key={action}>{failureActionLinks[action].label}</Link>)}</div>}
    {run && <div className="recommendation-run-controls">
      {(run.status === "queued" || run.status === "running") && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("pause")} type="button" variant="outline">暂停本次推荐</Button>}
      {run.status === "paused" && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("resume")} type="button">继续本次推荐</Button>}
      {["queued", "running", "paused"].includes(run.status) && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("cancel")} type="button" variant="outline">取消本次推荐</Button>}
      {resultHref && <Link className="workbench-touch-target recommendation-run-result-link" href={resultHref}>{run.result?.kind === "no_recommendations" ? "查看本次结论" : "查看本次推荐"}</Link>}
      {run.status === "failed" && run.failure?.suggestedActions.map((action) => action === "restart_discovery"
        ? <Button className="workbench-touch-target" key={action} onClick={() => void start()} type="button">重新开始今日发现</Button>
        : failureActionLinks[action as keyof typeof failureActionLinks]).filter(Boolean).map((link) => "href" in link
          ? <Link className="workbench-touch-target recommendation-run-link" href={link.href} key={link.href}>{link.label}</Link>
          : link)}
    </div>}
  </section>;
}
