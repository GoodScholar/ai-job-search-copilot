import type {
  AgentRunDetail,
  PublicSourceHealthAgentRunSourceScope,
} from "@job-copilot/contracts/agent-runs";
import { FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER, FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION } from "@job-copilot/contracts/agent-runs";
import type { SourceHealthAdapterFailure, SourceHealthDiscoveryAdapter, SourceHealthDetailResult, SourceHealthListResult } from "@job-copilot/domain/agent-runs";

export const FAKE_PUBLIC_SOURCE_HEALTH_SCENARIOS = [
  "healthy", "zero_valid_results", "missing_field", "invalid_url", "invalid_identity", "rate_limited", "hard_failed",
] as const;
export type FakePublicSourceHealthScenario = typeof FAKE_PUBLIC_SOURCE_HEALTH_SCENARIOS[number];

type Source = PublicSourceHealthAgentRunSourceScope["sources"][number];
type TargetSnapshot = AgentRunDetail["targetSnapshot"];

function failure(reasonCode: SourceHealthAdapterFailure["reasonCode"], retryable: boolean, attemptCount: number): SourceHealthAdapterFailure {
  if (reasonCode === "SOURCE_RATE_LIMITED") return { category: "rate_limited", reasonCode, retryable, attemptCount };
  if (reasonCode.startsWith("SOURCE_DETAIL_")) return { category: "parser_degraded", reasonCode, retryable, attemptCount };
  return { category: "hard_failed", reasonCode, retryable, attemptCount };
}

function detailId(source: Source): string { return `${source.sourceId.slice("greenhouse:".length)}-engineer-001`; }

function candidate(source: Source) {
  return { sourceId: source.sourceId, detailId: detailId(source), company: null, title: "Engineer", location: "Beijing" };
}

function matchesTarget(target: TargetSnapshot): boolean {
  return !target.constraints.roleFamily.trim() || "engineer".includes(target.constraints.roleFamily.trim().toLocaleLowerCase("en-US"));
}

/** 仅供 APP_ENV=test 的公共来源受控检查夹具；不产生任何网络请求。 */
export class FakePublicSourceHealthAdapter implements SourceHealthDiscoveryAdapter {
  readonly adapter = FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER;
  readonly adapterVersion = FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION;
  constructor(private readonly scenarios: Readonly<Record<string, FakePublicSourceHealthScenario>> = {}) {
    if (process.env.APP_ENV !== "test") throw new Error("FAKE_PUBLIC_SOURCE_HEALTH_TEST_ONLY");
  }

  async listSource(input: { targetSnapshot: TargetSnapshot; source: Source }): Promise<SourceHealthListResult> {
    const scenario = this.scenarios[input.source.sourceId] ?? "healthy";
    if (scenario === "rate_limited") return { ok: false, failure: failure("SOURCE_RATE_LIMITED", true, 2) };
    if (scenario === "hard_failed") return { ok: false, failure: failure("SOURCE_UNREACHABLE", true, 2) };
    if (scenario === "zero_valid_results") return { ok: true, data: { sourceId: input.source.sourceId, observedDetailIds: [], candidates: [] }, attemptCount: 1 };
    const items = matchesTarget(input.targetSnapshot) ? [candidate(input.source)] : [];
    return { ok: true, data: { sourceId: input.source.sourceId, observedDetailIds: items.map((item) => item.detailId), candidates: items }, attemptCount: 1 };
  }

  async getSourceDetail(input: { source: Source; detailId: string }): Promise<SourceHealthDetailResult> {
    const scenario = this.scenarios[input.source.sourceId] ?? "healthy";
    if (input.detailId !== detailId(input.source)) return { ok: false, failure: failure("SOURCE_DETAIL_IDENTITY_INVALID", false, 1) };
    if (scenario === "missing_field") return { ok: false, failure: failure("SOURCE_DETAIL_FIELDS_MISSING", false, 1) };
    if (scenario === "invalid_url") return { ok: false, failure: failure("SOURCE_DETAIL_URL_INVALID", false, 1) };
    if (scenario === "invalid_identity") return { ok: false, failure: failure("SOURCE_DETAIL_IDENTITY_INVALID", false, 1) };
    return {
      ok: true,
      data: {
        sourceId: input.source.sourceId, detailId: input.detailId, company: input.source.canonicalCompanyName, title: "Engineer",
        location: "Beijing", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true,
        absoluteUrl: `https://boards.greenhouse.io/${input.source.boardToken}/jobs/${input.detailId}`,
        rawPayload: { fixtureVersion: "fake-public-job-discovery-v1", sourceId: input.source.sourceId, detailId: input.detailId },
      },
      attemptCount: 1,
    };
  }
}
