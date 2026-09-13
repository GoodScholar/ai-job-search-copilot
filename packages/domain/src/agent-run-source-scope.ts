import {
  AgentRunSourceScopeSchema,
  PublicAgentRunSourceScopeSchema,
  PublicSourceHealthAgentRunSourceScopeSchema,
  DeepMatchAgentRunSourceScopeSchema,
  DeepMatchAgentRunPublicSourceScopeSchema,
  FAKE_JOB_DISCOVERY_ADAPTER,
  FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_SOURCE_IDS,
} from "@job-copilot/contracts/agent-runs";
import { RecommendationDiscoveryFactsSchema, type RecommendationDiscoveryFacts } from "@job-copilot/contracts/recommendation-discovery-facts";

function scopeSourceIds(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const scope = value as { trustedSources?: Array<{ source?: { sourceId?: unknown } }>; sources?: Array<string | { sourceId?: unknown }> };
  return (scope.trustedSources ?? []).map(({ source }) => source?.sourceId).concat((scope.sources ?? []).map((source) => typeof source === "string" ? source : source.sourceId));
}

function scopeQueryIds(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const scope = value as { publicDiscovery?: { queries?: Array<{ queryId?: unknown }> } };
  return (scope.publicDiscovery?.queries ?? []).map(({ queryId }) => queryId);
}

function uniqueIds(ids: unknown[]) {
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) throw new Error("RECOMMENDATION_DISCOVERY_FACTS_SCOPE_INVALID");
  return ids as string[];
}

/** 将原冻结计划与本次实际执行范围对齐；执行范围内的缺失事实必须显式失败。 */
export function completeRecommendationDiscoveryFacts(input: {
  plannedScope: unknown;
  executionScope: unknown;
  discoveryFacts: RecommendationDiscoveryFacts;
  publicDiscoveryEnabled: boolean;
}): RecommendationDiscoveryFacts {
  const plannedTrusted = uniqueIds(scopeSourceIds(input.plannedScope));
  const plannedQueries = uniqueIds(scopeQueryIds(input.plannedScope));
  const executedTrusted = uniqueIds(scopeSourceIds(input.executionScope));
  const executedQueries = uniqueIds(scopeQueryIds(input.executionScope));
  const plannedTrustedSet = new Set(plannedTrusted);
  const plannedQuerySet = new Set(plannedQueries);
  const executedTrustedSet = new Set(executedTrusted);
  const executedQuerySet = new Set(executedQueries);
  if (executedTrusted.some((id) => !plannedTrustedSet.has(id)) || executedQueries.some((id) => !plannedQuerySet.has(id)) || !input.publicDiscoveryEnabled && executedQueries.length > 0) throw new Error("RECOMMENDATION_DISCOVERY_FACTS_SCOPE_INVALID");

  const parsed = RecommendationDiscoveryFactsSchema.parse(input.discoveryFacts);
  const factTrusted = new Set(parsed.trusted.map(({ sourceId }) => sourceId));
  const factQueries = new Set(parsed.publicQueries.map(({ queryId }) => queryId));
  if (parsed.trusted.length !== executedTrusted.length || parsed.publicQueries.length !== executedQueries.length || executedTrusted.some((id) => !factTrusted.has(id)) || executedQueries.some((id) => !factQueries.has(id))) throw new Error("RECOMMENDATION_DISCOVERY_FACTS_SCOPE_INVALID");

  return RecommendationDiscoveryFactsSchema.parse({
    ...parsed,
    trusted: [
      ...parsed.trusted,
      ...plannedTrusted.filter((id) => !executedTrustedSet.has(id)).map((sourceId) => ({ sourceId, checked: false, outcome: "failed" as const, losses: [{ code: "DISCOVERY_BUDGET_EXCEEDED" as const, retryable: false }] })),
    ],
    publicQueries: [
      ...parsed.publicQueries,
      ...plannedQueries.filter((id) => !executedQuerySet.has(id)).map((queryId) => ({ queryId, checked: false, outcome: "failed" as const, losses: [{ code: input.publicDiscoveryEnabled ? "DISCOVERY_BUDGET_EXCEEDED" as const : "PUBLIC_DISCOVERY_UNAVAILABLE" as const, retryable: false }] })),
    ],
  });
}

/** 历史冻结来源只在执行时收窄，原快照仍用于审计。 */
export function narrowGreenhouseSourceScope(sourceScope: unknown, trustedSourceLimit: number): unknown {
  if (!sourceScope || typeof sourceScope !== "object" || Array.isArray(sourceScope)) return sourceScope;
  const scope = sourceScope as Record<string, unknown>;
  return scope.adapter === "greenhouse" && Array.isArray(scope.sources)
    ? { ...scope, sources: scope.sources.slice(0, trustedSourceLimit) }
    : sourceScope;
}

function isLegacySourceScope(value: unknown): value is {
  kind: "company_watchlist";
  adapter: "fake";
  adapterVersion: "fake-job-discovery-v1";
  sources: [typeof FAKE_JOB_DISCOVERY_SOURCE_IDS[0], typeof FAKE_JOB_DISCOVERY_SOURCE_IDS[1]];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && record.kind === "company_watchlist"
    && record.adapter === FAKE_JOB_DISCOVERY_ADAPTER
    && record.adapterVersion === FAKE_JOB_DISCOVERY_ADAPTER_VERSION
    && Array.isArray(record.sources)
    && record.sources.length === FAKE_JOB_DISCOVERY_SOURCE_IDS.length
    && record.sources.every((source, index) => source === FAKE_JOB_DISCOVERY_SOURCE_IDS[index]);
}

/** 仅为 #10 固定 fake 来源的已持久化运行补齐 Watchlist 版本。 */
export function normalizeAgentRunSourceScope(value: unknown) {
  if (isLegacySourceScope(value)) return AgentRunSourceScopeSchema.parse({ ...value, watchlistVersion: 0 });
  const fake = AgentRunSourceScopeSchema.safeParse(value);
  if (fake.success) return fake.data;
  const publicV2 = PublicAgentRunSourceScopeSchema.safeParse(value);
  if (publicV2.success) return publicV2.data;
  const deepMatch = DeepMatchAgentRunSourceScopeSchema.safeParse(value);
  return deepMatch.success ? deepMatch.data : PublicSourceHealthAgentRunSourceScopeSchema.parse(value);
}

/** 内部深匹配范围可含发布证据；面向 API 的运行投影必须剥离它。 */
export function projectPublicAgentRunSourceScope(value: unknown) {
  const deepMatch = DeepMatchAgentRunSourceScopeSchema.safeParse(value);
  if (!deepMatch.success) return normalizeAgentRunSourceScope(value);
  const { frozenRecommendationEvidence: _frozenRecommendationEvidence, ...publicScope } = deepMatch.data;
  return DeepMatchAgentRunPublicSourceScopeSchema.parse(publicScope);
}
