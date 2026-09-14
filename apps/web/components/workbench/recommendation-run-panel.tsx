"use client";

import { RecommendationRunPreparationSchema, RecommendationRunSchema, type RecommendationRun, type RecommendationRunPreparation } from "@job-copilot/contracts/recommendation-runs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const pollingIntervalMs = 15_000;
const stages = [["discovery", "发现岗位"], ["qualification", "资格筛选"], ["coarse_ranking", "初步排序"], ["deep_matching", "深度匹配"], ["result_publication", "发布结果"]] as const;
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
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
  if (run.status === "completed") return run.result?.kind === "no_recommendations" ? "本次未找到可信推荐" : "本次推荐已准备完成";
  if (run.status === "cancelled") return "本次推荐已取消";
  return run.failure?.summary ?? "本次推荐未完成";
}
async function readRun(runId: string): Promise<RecommendationRun> {
  const response = await fetch(`/api/recommendation-runs/${runId}`, { cache: "no-store" });
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

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const runId = run?.runId;
  const currentRunStatus = run?.status;
  const refreshRun = useCallback(async () => {
    if (!runId) return;
    try {
      const next = await readRun(runId);
      if (mounted.current) { setRun(next); setMessage(""); }
    } catch { if (mounted.current) setMessage("运行状态暂时无法读取，请稍后刷新页面重试。"); }
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
    const [preparationResponse, latestResponse] = await Promise.all([
      fetch("/api/recommendation-runs/preparation", { cache: "no-store" }), fetch("/api/recommendation-runs/latest", { cache: "no-store" }),
    ]);
    const nextPreparation = RecommendationRunPreparationSchema.safeParse(await preparationResponse.json().catch(() => null));
    const latestPayload = await latestResponse.json().catch(() => null);
    const nextRun = RecommendationRunSchema.safeParse(latestPayload && typeof latestPayload === "object" && "run" in latestPayload ? latestPayload.run : null);
    if (mounted.current) {
      if (nextPreparation.success) setPreparation(nextPreparation.data);
      if (nextRun.success) setRun(nextRun.data);
    }
  }, []);
  const preflight = preparation?.preflight ?? null;
  const accountStopped = preflight?.items.some((item) => item.code === "ACCOUNT_RUN_POLICY_BLOCKED") ?? false;
  const blocked = unavailable || preflight === null || preflight.status === "blocked";
  const unfinished = run !== null && !terminalStatuses.has(run.status);
  async function start(confirmed = false) {
    if (blocked || unfinished || pendingStart || !preflight) return;
    if (preflight.status === "ready_with_warnings" && !confirmed) { setConfirmationOpen(true); return; }
    idempotencyKey.current ??= crypto.randomUUID(); setPendingStart(true); setMessage("");
    try {
      const response = await fetch("/api/recommendation-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: idempotencyKey.current, warningFingerprint: preflight.status === "ready_with_warnings" ? preflight.warningFingerprint : null }) });
      const payload = await response.json().catch(() => null);
      const parsed = RecommendationRunSchema.safeParse(payload && typeof payload === "object" && "run" in payload ? payload.run : null);
      if (parsed.success && [200, 201].includes(response.status)) { setRun(parsed.data); setConfirmationOpen(false); idempotencyKey.current = null; onRunChanged?.(); return; }
      if (response.status === 409) { await refreshAuthoritativeState(); setConfirmationOpen(false); setMessage("启动条件已变化，已读取最新准备状态。"); return; }
      const stopped = payload && typeof payload === "object" && "code" in payload && payload.code === "ACCOUNT_RUN_STOPPED";
      setMessage(stopped ? "账户已停止全部运行，请先在运行设置中解除全局停止。" : "启动条件已变化，请刷新后查看最新状态。");
    } catch { setMessage("今日发现暂时无法启动，请稍后重试。"); }
    finally { if (mounted.current) setPendingStart(false); }
  }
  async function control(action: Action) {
    if (!run || pendingAction) return;
    const commandId = commandIds.current[action] ?? crypto.randomUUID(); commandIds.current[action] = commandId; setPendingAction(action); setMessage("");
    try {
      const response = await fetch(`/api/recommendation-runs/${run.runId}/controls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, action }) });
      const payload = await response.json().catch(() => null);
      const parsed = RecommendationRunSchema.safeParse(payload && typeof payload === "object" && "run" in payload ? payload.run : null);
      if (parsed.success && response.ok) { commandIds.current[action] = undefined; setRun(parsed.data); onRunChanged?.(); return; }
      if (response.status === 409) {
        await refreshRun();
        const stopped = payload && typeof payload === "object" && "code" in payload && payload.code === "ACCOUNT_RUN_STOPPED";
        setMessage(stopped ? "账户已停止全部运行，请先在运行设置中解除全局停止。" : "运行状态已变化，已读取最新状态。"); return;
      }
      setMessage("本次操作暂时无法提交，请稍后重试。");
    } catch { setMessage("本次操作暂时无法提交，请稍后重试。"); }
    finally { if (mounted.current) setPendingAction(null); }
  }
  const resultHref = run?.result ? `/recommendations?runId=${run.runId}&resultId=${run.result.resultId}#recommendation-result` : null;
  return <section aria-labelledby="recommendation-run-title" className="workbench-ledger recommendation-run-panel" id="recommendation-run">
    <div className="workbench-ledger-heading"><h2 id="recommendation-run-title">开始今日完整推荐</h2></div>
    {unavailable ? <p className="recommendation-run-message">推荐准备状态暂时无法读取，请稍后刷新页面重试。</p> : <>
      {preparation && <div className="recommendation-run-summary"><p>主目标：{preparation.target?.roleFamily ?? "尚未设置"}</p><p>本次将检查 {preparation.sourceScope.trustedSourceCount} 个可信来源和 {preparation.sourceScope.publicQueryCount} 条公开查询。</p><p>发现预算：最多 {preparation.budgets.discovery.maxResults} 条岗位；深度匹配预算：最多 {preparation.budgets.deepMatch.maxResults} 条。</p></div>}
      {preflight?.status === "blocked" && <div className="recommendation-run-notice"><p>{accountStopped ? "账户运行策略当前阻止启动。" : "请先处理启动前的阻塞项。"}</p><Link className="workbench-touch-target recommendation-run-link" href={accountStopped ? "/profile/run-policy" : "/profile/targets"}>查看运行设置</Link></div>}
      <div className="recommendation-run-start"><Button className="workbench-touch-target" disabled={blocked || unfinished || pendingStart} onClick={() => void start()} size="lg" type="button">{pendingStart ? "正在开始…" : unfinished ? "今日发现进行中" : "开始今日发现"}</Button></div>
      {confirmationOpen && <div className="recommendation-run-notice recommendation-run-warning"><p>{preflight?.items.filter((item) => item.severity === "warning").map((item) => `${item.summary}：${item.impact}`).join("；")}</p><Button className="workbench-touch-target" onClick={() => void start(true)} size="lg" type="button">我已了解，开始今日发现</Button></div>}
    </>}
    <ol aria-label="完整推荐阶段" className="recommendation-run-stages">{stages.map(([key, label]) => {
      const stage = run?.stages.find((candidate) => candidate.key === key);
      return <li aria-current={run?.currentStage === key ? "step" : undefined} data-status={stage?.status ?? "pending"} key={key}><h3>{label}</h3><p>{stage ? stageStatusLabel(stage.status) : "等待开始"}</p></li>;
    })}</ol>
    <p aria-live="polite" className={message ? "recommendation-run-live" : "recommendation-run-live is-empty"} role="status">{message || runStatus(run)}</p>
    {message.includes("账户已停止") && <Link className="workbench-touch-target recommendation-run-link" href="/profile/run-policy">查看运行设置</Link>}
    {run && <div className="recommendation-run-controls">
      {(run.status === "queued" || run.status === "running") && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("pause")} type="button" variant="outline">暂停本次推荐</Button>}
      {run.status === "paused" && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("resume")} type="button">继续本次推荐</Button>}
      {["queued", "running", "paused"].includes(run.status) && <Button className="workbench-touch-target" disabled={pendingAction !== null} onClick={() => void control("cancel")} type="button" variant="outline">取消本次推荐</Button>}
      {resultHref && <Link className="workbench-touch-target recommendation-run-result-link" href={resultHref}>{run.result?.kind === "no_recommendations" ? "查看本次结论" : "查看本次推荐"}</Link>}
      {run.status === "failed" && run.failure?.suggestedActions.includes("review_account_run_policy") && <Link className="workbench-touch-target recommendation-run-link" href="/profile/run-policy">查看运行设置</Link>}
    </div>}
  </section>;
}
