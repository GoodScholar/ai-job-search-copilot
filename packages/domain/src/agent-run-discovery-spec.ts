import { and, desc, eq } from "drizzle-orm";
import { companyWatchlistRevisions, companyWatchlists, jobProfiles, jobTargetRevisions, jobTargets, profileFactRevisions, profileFacts } from "@job-copilot/database";
import {
  AGENT_RUN_RULE_VERSION, AGENT_RUN_TOOL_ALLOWLIST, FAKE_JOB_DISCOVERY_ADAPTER, FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, FAKE_JOB_DISCOVERY_SOURCE_IDS, FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION,
  GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION,
  PublicSourceHealthAgentRunSourceScopeSchema,
} from "@job-copilot/contracts/agent-runs";
import {
  LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION,
} from "@job-copilot/contracts/job-discovery";
import { CompanyWatchlistItemSchema } from "@job-copilot/contracts/company-watchlists";
import { createAnySearchQueryPlan } from "./anysearch-query-plan";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import { AgentRunError } from "./agent-run-errors";
import { analyzePublicJobDiscoverySources } from "./public-job-discovery-sources";

export type DiscoveryTargetSnapshot = { targetId: string; version: number; priority: string; state: string; constraints: unknown };
export type DiscoveryWatchlist = { version: number; items: unknown } | undefined;
export type DiscoveryExecution = {
  budget: { maxActiveDurationMs: number; maxAttempts: number; maxToolCalls: number; maxResults: number; maxModelCalls: number; maxTokens: number };
  workflowVersion: string; ruleVersion: string; adapter: string; adapterVersion: string; outputSchemaVersion: string;
};
export type DiscoveryRunSpec = {
  execution: DiscoveryExecution;
  sourceScope: unknown;
  toolAllowlist: readonly string[];
  profileSnapshot?: unknown;
  watchlistSnapshot?: unknown;
};

export function discoverySourceScopeCounts(scope: unknown, executionMode: JobDiscoveryExecutionMode): { trustedSourceCount: number; publicQueryCount: number } {
  const value = scope as { sources?: unknown[]; trustedSources?: unknown[]; publicDiscovery?: { queries?: unknown[] } };
  return executionMode === "layered_public"
    ? { trustedSourceCount: value.trustedSources?.length ?? 0, publicQueryCount: value.publicDiscovery?.queries?.length ?? 0 }
    : { trustedSourceCount: value.sources?.length ?? 0, publicQueryCount: 0 };
}

export async function readDiscoveryTargetInTransaction(transaction: any, input: { userId: string; targetId: string }): Promise<DiscoveryTargetSnapshot | null> {
  const [target] = await transaction.select({ id: jobTargets.id, version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, constraints: jobTargetRevisions.constraints })
    .from(jobTargets).innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version)))
    .where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId)));
  return target ? { targetId: target.id, version: target.version, priority: target.priority, state: target.state, constraints: target.constraints } : null;
}

function sourceScope(watchlist: DiscoveryWatchlist) {
  const items = watchlist ? CompanyWatchlistItemSchema.array().parse(watchlist.items) : [];
  const disabled = new Set(items.filter((item) => item.state === "disabled").map((item) => item.careersUrl));
  const enabled = items.filter((item) => item.state === "enabled").sort((left, right) => left.position - right.position).map((item) => item.careersUrl);
  return { kind: "company_watchlist" as const, adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: watchlist?.version ?? 0, sources: [...new Set([...enabled, ...FAKE_JOB_DISCOVERY_SOURCE_IDS.filter((source) => !disabled.has(source))])] };
}

function publicSourceScope(watchlist: DiscoveryWatchlist, trustedSourceLimit: number) {
  const analysis = analyzePublicJobDiscoverySources(watchlist);
  if (analysis.status !== "executable") throw new AgentRunError("AGENT_RUN_UNAVAILABLE");
  const sources = analysis.sources.slice(0, trustedSourceLimit);
  if (sources.length === 0) throw new AgentRunError("AGENT_RUN_UNAVAILABLE");
  return PublicSourceHealthAgentRunSourceScopeSchema.parse({ kind: "company_watchlist", adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: watchlist?.version ?? 0, sources });
}

async function layeredPublicDiscoverySpec(transaction: any, input: { userId: string; targetSnapshot: DiscoveryTargetSnapshot; watchlist: DiscoveryWatchlist; policy: { trustedSourceLimit: number; publicQueryLimit: number; verificationCandidateLimit: number } }) {
  const [profile] = await transaction.select({ id: jobProfiles.id, version: jobProfiles.version }).from(jobProfiles).where(eq(jobProfiles.userId, input.userId));
  if (!profile || profile.version < 1) throw new AgentRunError("AGENT_RUN_UNAVAILABLE");
  const revisions = await transaction.select({ profileFactId: profileFacts.id, factType: profileFactRevisions.factType, factValue: profileFactRevisions.factValue, state: profileFactRevisions.state, revisionNumber: profileFactRevisions.revisionNumber })
    .from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id)))
    .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, profile.id))).orderBy(desc(profileFactRevisions.revisionNumber));
  const currentRevisions = new Map<string, typeof revisions[number]>();
  for (const revision of revisions) if (!currentRevisions.has(revision.profileFactId)) currentRevisions.set(revision.profileFactId, revision);
  const confirmedActiveSkillNames = [...new Set([...currentRevisions.values()].filter((revision) => revision.factType === "skill" && revision.state === "active").flatMap((revision) => {
    const value = revision.factValue;
    if (!value || typeof value !== "object" || Array.isArray(value) || !("name" in value) || typeof value.name !== "string") return [];
    const name = value.name.trim();
    return name ? [name] : [];
  }))].sort((left, right) => left.localeCompare(right, "zh-CN")).slice(0, 10);
  const items = input.watchlist ? CompanyWatchlistItemSchema.array().parse(input.watchlist.items) : [];
  const enabledItems = items.filter((item) => item.state === "enabled").sort((left, right) => left.position - right.position);
  const watchlistSnapshot = { targetId: input.targetSnapshot.targetId, version: input.watchlist?.version ?? 0, companies: enabledItems.map((item) => ({ watchlistItemId: item.itemId, canonicalCompanyName: item.canonicalCompanyName, allowedDomains: item.allowedDomains })) };
  const profileSnapshot = { targetId: input.targetSnapshot.targetId, version: profile.version, confirmedActiveSkillNames };
  const analysis = analyzePublicJobDiscoverySources(input.watchlist);
  const trustedSources = analysis.status === "executable" ? analysis.sources.slice(0, input.policy.trustedSourceLimit).map((source) => ({ kind: "greenhouse_trusted_source" as const, source })) : [];
  return { profileSnapshot, watchlistSnapshot, sourceScope: { kind: "layered_public" as const, trustedSources, publicDiscovery: createAnySearchQueryPlan({ targetSnapshot: input.targetSnapshot, profileSnapshot, watchlistSnapshot, publicQueryLimit: input.policy.publicQueryLimit, verificationCandidateLimit: input.policy.verificationCandidateLimit }) } };
}

export async function readDiscoveryWatchlistInTransaction(transaction: any, input: { userId: string; targetId: string }): Promise<DiscoveryWatchlist> {
  const [watchlist] = await transaction.select({ version: companyWatchlists.version, items: companyWatchlistRevisions.items })
    .from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(eq(companyWatchlistRevisions.userId, companyWatchlists.userId), eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id), eq(companyWatchlistRevisions.version, companyWatchlists.version)))
    .where(and(eq(companyWatchlists.userId, input.userId), eq(companyWatchlists.targetId, input.targetId)));
  return watchlist;
}

export async function buildDiscoveryRunSpecInTransaction(transaction: any, input: { userId: string; targetSnapshot: DiscoveryTargetSnapshot; watchlist: DiscoveryWatchlist; policy: { budgets: { fake: DiscoveryExecution["budget"]; publicDiscovery: DiscoveryExecution["budget"] }; discovery: { trustedSourceLimit: number; publicQueryLimit: number; verificationCandidateLimit: number; enabledProviders: readonly string[] } }; executionMode: JobDiscoveryExecutionMode }): Promise<DiscoveryRunSpec> {
  const canUseAnySearch = input.policy.discovery.enabledProviders.includes("anysearch") && input.policy.discovery.publicQueryLimit > 0;
  const layered = input.executionMode === "layered_public" ? await layeredPublicDiscoverySpec(transaction, { userId: input.userId, targetSnapshot: input.targetSnapshot, watchlist: input.watchlist, policy: { ...input.policy.discovery, publicQueryLimit: canUseAnySearch ? input.policy.discovery.publicQueryLimit : 0 } }) : null;
  if (layered && !layered.sourceScope.trustedSources.length && !layered.sourceScope.publicDiscovery.queries.length) throw new AgentRunError("AGENT_RUN_UNAVAILABLE");
  if (input.executionMode === "layered_public") return { execution: { budget: input.policy.budgets.publicDiscovery, workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION }, sourceScope: layered!.sourceScope, toolAllowlist: LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, profileSnapshot: layered!.profileSnapshot, watchlistSnapshot: layered!.watchlistSnapshot };
  if (input.executionMode === "greenhouse") return { execution: { budget: input.policy.budgets.publicDiscovery, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION }, sourceScope: publicSourceScope(input.watchlist, input.policy.discovery.trustedSourceLimit), toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST };
  return { execution: { budget: input.policy.budgets.fake, workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: AGENT_RUN_RULE_VERSION, adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION }, sourceScope: sourceScope(input.watchlist), toolAllowlist: AGENT_RUN_TOOL_ALLOWLIST };
}
