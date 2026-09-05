import {
  AgentRunSourceScopeSchema,
  PublicAgentRunSourceScopeSchema,
  PublicSourceHealthAgentRunSourceScopeSchema,
  DeepMatchAgentRunSourceScopeSchema,
  FAKE_JOB_DISCOVERY_ADAPTER,
  FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_SOURCE_IDS,
} from "@job-copilot/contracts/agent-runs";

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
