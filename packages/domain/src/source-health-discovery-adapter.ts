import type {
  AgentRunDetail,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
  DiscoveryDetailResult,
  PublicSourceHealthAgentRunSourceScope,
  SourceHealthReasonCode,
} from "@job-copilot/contracts/agent-runs";

type Source = PublicSourceHealthAgentRunSourceScope["sources"][number];
type Detail = Extract<DiscoveryDetailResult, { ok: true }>["data"];
type TargetSnapshot = AgentRunDetail["targetSnapshot"];

export type SourceHealthAdapterFailure = {
  category: "parser_degraded" | "rate_limited" | "hard_failed";
  reasonCode: SourceHealthReasonCode;
  retryable: boolean;
  attemptCount: number;
};

export type SourceHealthListResult =
  | { ok: true; data: { sourceId: string; observedDetailIds: string[]; candidates: Array<{ sourceId: string; detailId: string; company: null; title: string; location: string }> }; attemptCount: number }
  | { ok: false; failure: SourceHealthAdapterFailure };

export type SourceHealthDetailResult =
  | { ok: true; data: Detail; attemptCount: number }
  | { ok: false; failure: SourceHealthAdapterFailure };

/** v3 受控检查只在单一来源范围内报告可审计的列表和详情结果。 */
export interface SourceHealthDiscoveryAdapter {
  readonly adapter: typeof GREENHOUSE_JOB_DISCOVERY_ADAPTER | typeof FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER;
  readonly adapterVersion: typeof GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION | typeof FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION;
  listSource(input: { targetSnapshot: TargetSnapshot; source: Source }): Promise<SourceHealthListResult>;
  getSourceDetail(input: { source: Source; detailId: string }): Promise<SourceHealthDetailResult>;
}

export interface SourceHealthDiscoveryAdapterResolver {
  resolve(input: { runId: string; idempotencyKey: string; executionSpec: unknown; attemptCount: number }): SourceHealthDiscoveryAdapter;
}
