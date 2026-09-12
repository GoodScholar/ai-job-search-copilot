import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { companyWatchlistRevisions, companyWatchlists, jobSourceHealthChecks, jobTargets, profileFactRevisions, profileFacts, type Database } from "@job-copilot/database";
import { type AccountRunPolicySettings } from "@job-copilot/contracts/account-run-policies";
import {
  RunPreflightReportSchema, type RunPreflightCheckCode, type RunPreflightItem,
  type RunPreflightReport, type RunPreflightSuggestedAction,
} from "@job-copilot/contracts/run-preflight";
import { resolveEffectiveAccountRunPolicy } from "./account-run-policies";
import { readAccountRunControlInTransaction } from "./account-run-admission";
import { isDateInBackgroundWindow } from "./account-run-policy-window";
import { analyzePublicJobDiscoverySources } from "./public-job-discovery-sources";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import { type ModelDiagnosticProjectionReader, createModelDiagnosticProjectionReader } from "./model-diagnostics";
import type { SourceCapabilityAdapter } from "./source-capabilities";
import { buildDiscoveryRunSpecInTransaction, discoverySourceScopeCounts, readDiscoveryTargetInTransaction, readDiscoveryWatchlistInTransaction, type DiscoveryRunSpec, type DiscoveryTargetSnapshot } from "./agent-run-discovery-spec";
import { AgentRunError } from "./agent-run-errors";

export type { ModelDiagnosticProjectionReader } from "./model-diagnostics";

export type RunPreflightInput = {
  userId: string;
  targetId?: string;
  workflow: "discovery" | "deep_match" | "recommendation";
  trigger: "manual" | "schedule" | "automatic";
  scheduledFor?: Date;
};
export type RunPreflightEvaluation = {
  report: RunPreflightReport;
  policy: { revisionNumber: number; snapshot: AccountRunPolicySettings };
  recommendationPlan?: { targetSnapshot: DiscoveryTargetSnapshot; discoverySpec: DiscoveryRunSpec | null };
};
export type RunPreflightDatabase = Pick<Database, "select" | "insert" | "execute">;
export type RunPreflightEvaluator = { evaluate(db: RunPreflightDatabase, input: RunPreflightInput): Promise<RunPreflightEvaluation> };

type Target = { targetId: string; version: number; state: "active" | "inactive"; priority: "primary" | "secondary" };
type Source = { itemId: string; sourceId: string };
const sourceActions: RunPreflightSuggestedAction[] = ["review_source_capabilities"];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function copy(code: RunPreflightCheckCode): readonly [string, string] {
  switch (code) {
    case "PROFILE_EVIDENCE_MISSING": return ["缺少可用画像事实", "请先确认至少一条画像事实后再启动运行。"];
    case "PROFILE_EVIDENCE_READY": return ["画像事实已就绪", "当前画像事实可用于本次运行。"];
    case "PRIMARY_JOB_TARGET_MISSING": return ["缺少活动主目标", "请先设置一个活动主求职目标。"];
    case "PRIMARY_JOB_TARGET_READY": return ["主目标已就绪", "当前活动主目标可用于本次运行。"];
    case "REQUESTED_JOB_TARGET_MISSING": return ["请求的目标不存在", "请选择当前账户中的求职目标。"];
    case "REQUESTED_JOB_TARGET_INACTIVE": return ["请求的目标未启用", "请启用该求职目标或选择其他目标。"];
    case "REQUESTED_JOB_TARGET_READY": return ["请求目标已就绪", "请求的活动目标可用于本次运行。"];
    case "SOURCE_CAPABILITY_UNAVAILABLE": return ["没有可执行的真实来源", "请配置并启用支持的 Greenhouse 来源。"];
    case "SOURCE_CAPABILITY_PARTIAL": return ["部分来源能力不足", "部分启用来源不能满足本次运行所需能力。"];
    case "SOURCE_CAPABILITY_READY": return ["来源能力已就绪", "启用的真实来源满足本次运行能力要求。"];
    case "SOURCE_CAPABILITY_NOT_REQUIRED": return ["来源能力无需检查", "深度匹配不直接执行来源发现。"];
    case "SOURCE_HEALTH_UNCHECKED": return ["来源尚未完成健康检查", "运行可以继续，建议稍后查看来源健康状态。"];
    case "SOURCE_HEALTH_DEGRADED": return ["部分来源健康异常", "运行可以继续，建议检查异常来源。"];
    case "SOURCE_HEALTH_READY": return ["来源健康已就绪", "已检查来源当前没有退化状态。"];
    case "SOURCE_HEALTH_NOT_REQUIRED": return ["来源健康无需检查", "深度匹配不直接执行来源发现。"];
    case "MODEL_DIAGNOSTIC_UNAVAILABLE": return ["模型诊断不可用", "请先完成模型连接检查。"];
    case "MODEL_DIAGNOSTIC_READY": return ["模型诊断已就绪", "当前模型诊断显示可安全使用。"];
    case "ACCOUNT_RUN_POLICY_BLOCKED": return ["账户运行策略阻止启动", "请检查运行预算或后台时间窗口。"];
    case "ACCOUNT_RUN_POLICY_READY": return ["账户运行策略已就绪", "当前预算和时间窗口允许本次运行。"];
  }
}
function item(code: RunPreflightCheckCode, severity: "blocking" | "warning" | "informational", evidence: RunPreflightItem["evidence"], retryable: boolean, suggestedActions: RunPreflightSuggestedAction[]): RunPreflightItem {
  const [summary, impact] = copy(code);
  return { code, severity, summary, evidence, impact, retryable, suggestedActions };
}
function status(items: RunPreflightItem[]): "blocked" | "ready_with_warnings" | "ready" {
  return items.some((value) => value.severity === "blocking") ? "blocked" : items.some((value) => value.severity === "warning") ? "ready_with_warnings" : "ready";
}
function fingerprintEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fingerprintEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "checkedAt" && key !== "latestCheckedAt")
    .map(([key, nested]) => [key, fingerprintEvidence(nested)]));
  return value;
}
/** 警告确认使用的最小、稳定安全投影；不接受展示文案或执行元数据。 */
export function fingerprintRunPreflightWarnings(input: {
  workflow: RunPreflightInput["workflow"];
  trigger: RunPreflightInput["trigger"];
  targetId: string | null;
  warnings: ReadonlyArray<Pick<RunPreflightItem, "code" | "evidence" | "suggestedActions">>;
}): string {
  const warnings = input.warnings.map(({ code, evidence, suggestedActions }) => ({ code, evidence: fingerprintEvidence(evidence), suggestedActions: [...suggestedActions].sort() })).sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return createHash("sha256").update(canonical({ version: "run-preflight-v1", workflow: input.workflow, trigger: input.trigger, targetId: input.targetId, warnings })).digest("hex");
}
function fingerprint(input: { workflow: RunPreflightInput["workflow"]; trigger: RunPreflightInput["trigger"]; targetId: string | null; items: RunPreflightItem[] }): string | null {
  const warnings = input.items.filter((value) => value.severity === "warning").map(({ code, evidence, suggestedActions }) => ({ code, evidence, suggestedActions }));
  return warnings.length ? fingerprintRunPreflightWarnings({ workflow: input.workflow, trigger: input.trigger, targetId: input.targetId, warnings }) : null;
}

async function targets(db: Pick<Database, "select">, userId: string): Promise<Target[]> {
  const rows = await db.select({ targetId: jobTargets.id, version: jobTargets.version, state: jobTargets.state, priority: jobTargets.priority })
    .from(jobTargets).where(eq(jobTargets.userId, userId));
  return rows.map((row) => ({ targetId: row.targetId, version: row.version, state: row.state as Target["state"], priority: row.priority as Target["priority"] }));
}
async function activeFacts(db: Pick<Database, "select">, userId: string) {
  const rows = await db.select({ factId: profileFacts.id, revisionId: profileFactRevisions.id, revisionNumber: profileFactRevisions.revisionNumber, createdAt: profileFactRevisions.createdAt, state: profileFactRevisions.state })
    .from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id)))
    .where(eq(profileFacts.userId, userId)).orderBy(desc(profileFactRevisions.revisionNumber), desc(profileFactRevisions.createdAt), desc(profileFactRevisions.id));
  const current = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!current.has(row.factId)) current.set(row.factId, row);
  const active = [...current.values()].filter((row) => row.state === "active").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.revisionId.localeCompare(a.revisionId));
  return { count: active.length, latestRevisionId: active[0]?.revisionId ?? null };
}
async function sources(db: Pick<Database, "select">, userId: string, targetId: string | null): Promise<Source[]> {
  if (!targetId) return [];
  const [watchlist] = await db.select({ items: companyWatchlistRevisions.items }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(
    eq(companyWatchlistRevisions.userId, companyWatchlists.userId), eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id), eq(companyWatchlistRevisions.version, companyWatchlists.version),
  )).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
  if (!watchlist) return [];
  const analysis = analyzePublicJobDiscoverySources(watchlist);
  return analysis.status === "executable" ? analysis.sources.map((source) => ({ itemId: source.watchlistItemId, sourceId: source.sourceId })) : [];
}
function capabilities(adapter: SourceCapabilityAdapter, input: RunPreflightInput, sources: Source[]) {
  const required: Array<"active_discovery" | "read_details" | "continuous_monitoring"> = input.trigger === "schedule" ? ["active_discovery", "read_details", "continuous_monitoring"] : ["active_discovery", "read_details"];
  let count = 0;
  for (const source of sources) {
    try {
      const declaration = adapter.declareCapabilities({ sourceId: source.sourceId });
      if (declaration.sourceId === source.sourceId && declaration.adapter === adapter.adapter && declaration.adapterVersion === adapter.adapterVersion && required.every((action) => declaration.capabilities.includes(action))) count += 1;
    } catch { /* 适配器错误不跨越安全投影边界。 */ }
  }
  return count;
}
async function health(db: Pick<Database, "select">, userId: string, targetId: string | null, sources: Source[]) {
  if (!targetId || !sources.length) return { checked: 0, healthy: 0, degraded: 0, unchecked: sources.length, latest: null as Date | null };
  const allowed = new Set(sources.map((source) => `${source.itemId}:${source.sourceId}`));
  const rows = await db.select({ id: jobSourceHealthChecks.id, itemId: jobSourceHealthChecks.watchlistItemId, sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, checkedAt: jobSourceHealthChecks.checkedAt })
    .from(jobSourceHealthChecks).where(and(eq(jobSourceHealthChecks.userId, userId), eq(jobSourceHealthChecks.targetId, targetId)))
    .orderBy(desc(jobSourceHealthChecks.checkedAt), desc(jobSourceHealthChecks.id));
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) { const key = `${row.itemId}:${row.sourceId}`; if (allowed.has(key) && !latest.has(key)) latest.set(key, row); }
  const values = [...latest.values()];
  return {
    checked: values.length,
    healthy: values.filter((value) => value.status === "healthy" || value.status === "zero_valid_results").length,
    degraded: values.filter((value) => value.status === "parser_degraded" || value.status === "rate_limited" || value.status === "hard_failed").length,
    unchecked: sources.length - values.length,
    latest: values.reduce<Date | null>((maximum, value) => !maximum || value.checkedAt > maximum ? value.checkedAt : maximum, null),
  };
}
function usableBudget(settings: AccountRunPolicySettings, input: RunPreflightInput, mode: JobDiscoveryExecutionMode, now: Date): boolean {
  const discoveryBudget = mode === "fake" ? settings.budgets.fake : settings.budgets.publicDiscovery;
  const discoveryRequired = [discoveryBudget.maxActiveDurationMs, discoveryBudget.maxAttempts, discoveryBudget.maxToolCalls, discoveryBudget.maxResults];
  const deepMatchBudget = settings.budgets.deepMatch;
  const deepMatchRequired = [deepMatchBudget.maxActiveDurationMs, deepMatchBudget.maxAttempts, deepMatchBudget.maxResults, deepMatchBudget.maxModelCalls, deepMatchBudget.maxTokens];
  const required = input.workflow === "deep_match" ? deepMatchRequired : input.workflow === "recommendation" ? [...discoveryRequired, ...deepMatchRequired] : discoveryRequired;
  if (required.some((value) => value <= 0)) return false;
  if (input.trigger !== "schedule") return true;
  return input.scheduledFor !== undefined
    && isDateInBackgroundWindow(now, settings.backgroundWindow)
    && isDateInBackgroundWindow(input.scheduledFor, settings.backgroundWindow);
}

export function createRunPreflightEvaluator(deps: { capabilityAdapter: SourceCapabilityAdapter; modelDiagnosticReader: ModelDiagnosticProjectionReader; discoveryExecutionMode: JobDiscoveryExecutionMode; id: () => string; clock: () => Date }): RunPreflightEvaluator {
  return {
    async evaluate(db, input) {
      const checkedAt = deps.clock();
      const [facts, allTargets, policy, control] = await Promise.all([
        activeFacts(db, input.userId), targets(db, input.userId), resolveEffectiveAccountRunPolicy(db, input.userId, { id: deps.id, clock: deps.clock }),
        readAccountRunControlInTransaction(db, input.userId),
      ]);
      const primary = allTargets.find((value) => value.priority === "primary" && value.state === "active") ?? null;
      const requested = input.workflow === "recommendation" ? primary : input.targetId ? allTargets.find((value) => value.targetId === input.targetId) ?? null : primary;
      // A foreign/missing caller-supplied id is never reflected in the public report.
      // It is indistinguishable from a missing request and falls back to the owner's primary target.
      const safeRequestedTargetId = requested?.targetId ?? (input.targetId ? null : primary?.targetId ?? null);
      const targetId = requested?.state === "active" ? requested.targetId : primary?.targetId ?? null;
      const realSources = (await sources(db, input.userId, targetId)).slice(0, policy.effective.discovery.trustedSourceLimit);
      let recommendationPlan: RunPreflightEvaluation["recommendationPlan"];
      if (input.workflow === "recommendation" && targetId) {
        const targetSnapshot = await readDiscoveryTargetInTransaction(db, { userId: input.userId, targetId });
        if (targetSnapshot?.state === "active" && targetSnapshot.priority === "primary") {
          const watchlist = await readDiscoveryWatchlistInTransaction(db, { userId: input.userId, targetId });
          let discoverySpec: DiscoveryRunSpec | null = null;
          try {
            discoverySpec = await buildDiscoveryRunSpecInTransaction(db, { userId: input.userId, targetSnapshot, watchlist, policy: policy.effective, executionMode: deps.discoveryExecutionMode });
          } catch (error) {
            if (!(error instanceof AgentRunError) || error.code !== "AGENT_RUN_UNAVAILABLE") throw error;
          }
          recommendationPlan = { targetSnapshot, discoverySpec };
        }
      }
      const publicQueryCount = recommendationPlan?.discoverySpec && deps.discoveryExecutionMode === "layered_public"
        ? discoverySourceScopeCounts(recommendationPlan.discoverySpec.sourceScope, deps.discoveryExecutionMode).publicQueryCount
        : 0;
      const model = await deps.modelDiagnosticReader.get(db, checkedAt);
      const items: RunPreflightItem[] = [];
      items.push(item(facts.count ? "PROFILE_EVIDENCE_READY" : "PROFILE_EVIDENCE_MISSING", facts.count ? "informational" : "blocking", { kind: "profile", activeTrustedFactCount: facts.count, latestFactRevisionId: facts.latestRevisionId, checkedAt: checkedAt.toISOString() }, false, facts.count ? [] : ["review_profile"]));
      items.push(item(primary ? "PRIMARY_JOB_TARGET_READY" : "PRIMARY_JOB_TARGET_MISSING", primary ? "informational" : "blocking", { kind: "job_target", primaryTargetId: primary?.targetId ?? null, primaryTargetVersion: primary?.version ?? null, requestedTargetId: safeRequestedTargetId, requestedTargetVersion: requested?.version ?? null, requestedTargetState: requested?.state ?? "missing", checkedAt: checkedAt.toISOString() }, false, primary ? [] : ["review_job_targets"]));
      const requestedCode = !requested ? "REQUESTED_JOB_TARGET_MISSING" : requested.state !== "active" ? "REQUESTED_JOB_TARGET_INACTIVE" : "REQUESTED_JOB_TARGET_READY";
      items.push(item(requestedCode, requestedCode === "REQUESTED_JOB_TARGET_READY" ? "informational" : "blocking", { kind: "job_target", primaryTargetId: primary?.targetId ?? null, primaryTargetVersion: primary?.version ?? null, requestedTargetId: safeRequestedTargetId, requestedTargetVersion: requested?.version ?? null, requestedTargetState: requested?.state ?? "missing", checkedAt: checkedAt.toISOString() }, false, requestedCode === "REQUESTED_JOB_TARGET_READY" ? [] : ["review_job_targets"]));
      if (input.workflow === "deep_match") {
        items.push(item("SOURCE_CAPABILITY_NOT_REQUIRED", "informational", { kind: "source_capability", enabledSourceCount: 0, capableSourceCount: 0, status: "not_required", checkedAt: checkedAt.toISOString() }, false, []));
        items.push(item("SOURCE_HEALTH_NOT_REQUIRED", "informational", { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 0, latestCheckedAt: null }, false, []));
      } else {
        const capable = capabilities(deps.capabilityAdapter, input, realSources);
        const capabilityCode = realSources.length === 0 || capable === 0
          ? publicQueryCount > 0 ? "SOURCE_CAPABILITY_PARTIAL" : "SOURCE_CAPABILITY_UNAVAILABLE"
          : capable === realSources.length ? "SOURCE_CAPABILITY_READY" : "SOURCE_CAPABILITY_PARTIAL";
        items.push(item(capabilityCode, capabilityCode === "SOURCE_CAPABILITY_UNAVAILABLE" ? "blocking" : capabilityCode === "SOURCE_CAPABILITY_PARTIAL" ? "warning" : "informational", { kind: "source_capability", enabledSourceCount: realSources.length, capableSourceCount: capable, status: capabilityCode === "SOURCE_CAPABILITY_UNAVAILABLE" ? "unavailable" : capabilityCode === "SOURCE_CAPABILITY_PARTIAL" ? "partial" : "ready", checkedAt: checkedAt.toISOString() }, capabilityCode !== "SOURCE_CAPABILITY_READY", capabilityCode === "SOURCE_CAPABILITY_READY" ? [] : sourceActions));
        const sourceHealth = await health(db, input.userId, targetId, realSources);
        const healthCode = sourceHealth.degraded ? "SOURCE_HEALTH_DEGRADED" : sourceHealth.unchecked ? "SOURCE_HEALTH_UNCHECKED" : "SOURCE_HEALTH_READY";
        items.push(item(healthCode, healthCode === "SOURCE_HEALTH_READY" ? "informational" : "warning", { kind: "source_health", checkedSourceCount: sourceHealth.checked, healthySourceCount: sourceHealth.healthy, degradedSourceCount: sourceHealth.degraded, uncheckedSourceCount: sourceHealth.unchecked, latestCheckedAt: sourceHealth.latest?.toISOString() ?? null }, true, healthCode === "SOURCE_HEALTH_READY" ? [] : ["review_source_health"]));
      }
      items.push(item(model.status === "available" ? "MODEL_DIAGNOSTIC_READY" : "MODEL_DIAGNOSTIC_UNAVAILABLE", model.status === "available" ? "informational" : "blocking", { kind: "model_diagnostic", status: model.status, checkedAt: model.checkedAt }, model.status !== "available", model.status === "available" ? [] : ["run_model_diagnostic"]));
      const policyReady = usableBudget(policy.effective, input, deps.discoveryExecutionMode, checkedAt) && control.stoppedAt === null;
      const policyItem = item(policyReady ? "ACCOUNT_RUN_POLICY_READY" : "ACCOUNT_RUN_POLICY_BLOCKED", policyReady ? "informational" : "blocking", { kind: "account_run_policy", revisionNumber: policy.revisionNumber, status: policyReady ? "ready" : "blocked", checkedAt: checkedAt.toISOString() }, false, policyReady ? [] : ["review_account_run_policy"]);
      items.push(control.stoppedAt === null ? policyItem : { ...policyItem, summary: "账户已停止全部运行" });
      const report = RunPreflightReportSchema.parse({ version: "run-preflight-v1", workflow: input.workflow, trigger: input.trigger, targetId, status: status(items), items, warningFingerprint: fingerprint({ workflow: input.workflow, trigger: input.trigger, targetId, items }), checkedAt: checkedAt.toISOString() });
      return { report, policy: { revisionNumber: policy.revisionNumber, snapshot: policy.effective }, ...(recommendationPlan ? { recommendationPlan } : {}) };
    },
  };
}

export function createRunPreflightQueries(deps: { db: Database; evaluator: RunPreflightEvaluator }): { get(input: RunPreflightInput): Promise<RunPreflightReport> } {
  return { async get(input) { return deps.db.transaction(async (transaction) => (await deps.evaluator.evaluate(transaction, input)).report); } };
}

export class RunPreflightRejectedError extends Error {
  constructor(public readonly code: "RUN_PREFLIGHT_BLOCKED" | "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", public readonly report: RunPreflightReport) { super(code); }
}
export function authorizeRunPreflight(input: { evaluation: RunPreflightEvaluation; warningFingerprint: string | null }): void {
  const { report } = input.evaluation;
  if (report.status === "blocked") throw new RunPreflightRejectedError("RUN_PREFLIGHT_BLOCKED", report);
  if (report.trigger === "manual" && report.status === "ready_with_warnings" && input.warningFingerprint !== report.warningFingerprint) throw new RunPreflightRejectedError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", report);
}

export { createModelDiagnosticProjectionReader };
