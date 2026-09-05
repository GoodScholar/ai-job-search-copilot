"use client";

import { ModelDiagnosticPublicResponseSchema, type ModelDiagnosticCheckStatus, type ModelDiagnosticPublicResponse } from "@job-copilot/contracts/model-diagnostics";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const checks: Array<[keyof ModelDiagnosticPublicResponse["checks"], string]> = [
  ["authentication", "身份验证"], ["modelAvailability", "模型可用性"], ["structuredOutput", "结构化输出"], ["timeout", "响应时限"],
];
const statusText: Record<ModelDiagnosticCheckStatus, string> = { passed: "通过", failed: "未通过", not_verified: "未确认" };
const statusTitle: Record<ModelDiagnosticPublicResponse["status"], string> = {
  unverified: "尚未完成模型连接检查", checking: "模型连接正在检查", available: "模型连接正常", failed: "模型连接检查失败", temporarily_unavailable: "模型连接暂不可用",
};

function formatTime(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

async function readDiagnostics(path: string, init: RequestInit, signal: AbortSignal): Promise<ModelDiagnosticPublicResponse | null> {
  const response = await fetch(path, { ...init, cache: "no-store", signal });
  const parsed = ModelDiagnosticPublicResponseSchema.safeParse(await response.json().catch(() => null));
  return response.ok && parsed.success ? parsed.data : null;
}

export function ModelConnectionView({ initialDiagnostics }: { initialDiagnostics: ModelDiagnosticPublicResponse }) {
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [requesting, setRequesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState("");
  const [expiredRetryAt, setExpiredRetryAt] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const pollingController = useRef<AbortController | null>(null);
  const pollingTimer = useRef<number | null>(null);
  const retryPending = Boolean(diagnostics.retryAt && expiredRetryAt !== diagnostics.retryAt);

  useEffect(() => () => {
    requestController.current?.abort();
    pollingController.current?.abort();
    if (pollingTimer.current) window.clearTimeout(pollingTimer.current);
  }, []);

  useEffect(() => {
    if (!diagnostics.retryAt || expiredRetryAt === diagnostics.retryAt) return;
    const retryAt = new Date(diagnostics.retryAt);
    let timer: number | undefined;
    const refresh = () => {
      const remaining = retryAt.getTime() - Date.now();
      if (remaining <= 0) {
        setExpiredRetryAt(diagnostics.retryAt);
        return;
      }
      timer = window.setTimeout(refresh, Math.min(remaining, 2_147_483_647));
    };
    timer = window.setTimeout(refresh, 0);
    return () => { if (timer) window.clearTimeout(timer); };
  }, [diagnostics.retryAt, expiredRetryAt]);

  useEffect(() => {
    if (!polling) return;
    let active = true;
    let count = 0;
    const controller = new AbortController();
    pollingController.current = controller;
    const poll = async () => {
      if (!active) return;
      if (count >= 25) {
        setPolling(false);
        setRequesting(false);
        setMessage("检查仍在进行，可稍后刷新");
        return;
      }
      count += 1;
      const next = await readDiagnostics("/api/model-diagnostics", { method: "GET" }, controller.signal).catch(() => null);
      if (!active) return;
      if (!next) {
        setPolling(false);
        setRequesting(false);
        setMessage("暂时无法读取模型连接状态，请稍后刷新。");
        return;
      }
      setDiagnostics(next);
      if (next.status !== "checking") {
        setPolling(false);
        setRequesting(false);
        return;
      }
      pollingTimer.current = window.setTimeout(() => { void poll(); }, 1_000);
    };
    pollingTimer.current = window.setTimeout(() => { void poll(); }, 1_000);
    return () => {
      active = false;
      controller.abort();
      if (pollingTimer.current) window.clearTimeout(pollingTimer.current);
    };
  }, [polling]);

  async function runCheck() {
    if (requesting || retryPending) return;
    setRequesting(true);
    setMessage("");
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const next = await readDiagnostics("/api/model-diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, controller.signal).catch(() => null);
    if (requestController.current === controller) requestController.current = null;
    if (!next) {
      setRequesting(false);
      setMessage("暂时无法检查模型连接，请稍后重试。");
      return;
    }
    setDiagnostics(next);
    if (next.status === "checking") setPolling(true);
    else setRequesting(false);
  }

  const liveText = message || diagnostics.reasonSummary;
  return <main className="container workbench-main model-connection-main">
    <section aria-labelledby="model-connection-title" className="profile-intro">
      <h1 id="model-connection-title">模型连接</h1>
      <p>检查当前部署是否能安全使用模型功能。检查不会展示或请求你的账户信息。</p>
    </section>
    <section aria-labelledby="model-connection-status-title" className="workbench-ledger model-connection-ledger">
      <div className="workbench-ledger-heading"><h2 id="model-connection-status-title" title={statusTitle[diagnostics.status]}>{statusTitle[diagnostics.status]}</h2></div>
      <p aria-live="polite" className="model-connection-live" role="status">{liveText}</p>
      <dl className="model-connection-details">
        <div><dt>原因</dt><dd>{diagnostics.reasonSummary}</dd></div>
        <div><dt>影响</dt><dd>{diagnostics.impact}</dd></div>
        <div><dt>上次检查</dt><dd>{formatTime(diagnostics.checkedAt) ?? "尚未检查"}</dd></div>
        <div><dt>响应速度</dt><dd>{diagnostics.latencyBucket ? { under_1s: "1 秒内", "1_to_5s": "1–5 秒", "5_to_10s": "5–10 秒", "10_to_20s": "10–20 秒", timeout: "已超时" }[diagnostics.latencyBucket] : "尚未检查"}</dd></div>
      </dl>
      <section aria-labelledby="model-connection-checks-title" className="model-connection-checks">
        <h3 id="model-connection-checks-title">检查项目</h3>
        <ul>{checks.map(([key, label]) => <li key={key}><span>{label}</span><strong title={`${label}：${statusText[diagnostics.checks[key]]}`}>{statusText[diagnostics.checks[key]]}</strong></li>)}</ul>
      </section>
      {diagnostics.suggestedActions.length > 0 && <section aria-labelledby="model-connection-actions-title" className="model-connection-actions"><h3 id="model-connection-actions-title">建议</h3><ul>{diagnostics.suggestedActions.map((action) => <li key={action}>{action}</li>)}</ul></section>}
      {retryPending && <p className="model-connection-retry">可在 {formatTime(diagnostics.retryAt)} 后重试。</p>}
      <Button className="workbench-touch-target" disabled={requesting || retryPending} onClick={() => void runCheck()} size="lg" type="button">{requesting ? "正在检查…" : "检查模型连接"}</Button>
    </section>
  </main>;
}
