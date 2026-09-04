import type {
  AgentRunDetail,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
  SourceHealthDetailResult,
  SourceHealthListResult,
  PublicSourceHealthAgentRunSourceScope,
} from "@job-copilot/contracts/agent-runs";
import type { SourceCapabilityAdapter } from "./source-capabilities";
export type { SourceHealthDetailResult, SourceHealthListResult } from "@job-copilot/contracts/agent-runs";

type Source = PublicSourceHealthAgentRunSourceScope["sources"][number];
type TargetSnapshot = AgentRunDetail["targetSnapshot"];
export type SourceHealthAdapterFailure = Extract<SourceHealthListResult, { ok: false }> ["failure"];

/** v3 受控检查只在单一来源范围内报告可审计的列表和详情结果。 */
export interface SourceHealthDiscoveryAdapter extends SourceCapabilityAdapter {
  readonly adapter: typeof GREENHOUSE_JOB_DISCOVERY_ADAPTER | typeof FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER;
  readonly adapterVersion: typeof GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION | typeof FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION;
  listSource(input: { targetSnapshot: TargetSnapshot; source: Source }): Promise<SourceHealthListResult>;
  getSourceDetail(input: { source: Source; detailId: string }): Promise<SourceHealthDetailResult>;
}

export interface SourceHealthDiscoveryAdapterResolver {
  resolve(input: { runId: string; idempotencyKey: string; executionSpec: unknown; attemptCount: number }): SourceHealthDiscoveryAdapter;
}
