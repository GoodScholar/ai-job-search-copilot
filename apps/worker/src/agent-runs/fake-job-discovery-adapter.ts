import { AGENT_RUN_BUDGET } from "@job-copilot/contracts/agent-runs";
import { declareFormalBetaSourceCapabilities, type SourceCapabilityDeclaration } from "@job-copilot/contracts/source-capabilities";
import type {
  DiscoveryBatchSearchInput,
  DiscoveryBatchSearchResult,
  DiscoveryDetailInput,
  DiscoveryDetailResult,
  DiscoverySearchInput,
  DiscoverySearchResult,
} from "@job-copilot/contracts/agent-runs";
import type { JobDiscoveryAdapter } from "@job-copilot/domain/agent-runs";

type AdapterFailure = { code: string; retryable: boolean };
type AdapterOperation = "search" | "searchBatch" | "getDetail";

export type FakeJobDiscoveryAdapterOptions = {
  failures?: Partial<Record<AdapterOperation, AdapterFailure>>;
  delayMs?: number;
};

type Fixture = {
  sourceId: string;
  detailId: string;
  company: string;
  title: string;
  location: string;
  postedAt: string;
  deadline: string | null;
  industry: string;
  rawPayload: Record<string, unknown>;
};

const fixtures: readonly Fixture[] = [
  fixture("fake:aurora-careers", "aurora-ai-001", "曙光云图", "AI 应用工程师", "北京", "人工智能"),
  fixture("fake:aurora-careers", "aurora-frontend-001", "曙光云图", "高级前端工程师", "上海", "云计算"),
  fixture("fake:aurora-careers", "aurora-fullstack-001", "曙光云图", "全栈工程师", "杭州", "云计算"),
  fixture("fake:orbit-careers", "orbit-agent-001", "星轨智造", "Agent 工程师", "北京", "企业服务"),
  fixture("fake:orbit-careers", "orbit-ai-001", "星轨智造", "AI 应用工程师", "深圳", "人工智能"),
  fixture("fake:orbit-careers", "orbit-platform-001", "星轨智造", "平台工程师", "上海", "企业服务"),
];

function fixture(
  sourceId: string,
  detailId: string,
  company: string,
  title: string,
  location: string,
  industry: string,
): Fixture {
  const postedAt = "2026-08-20T00:00:00.000Z";
  return {
    sourceId,
    detailId,
    company,
    title,
    location,
    postedAt,
    deadline: null,
    industry,
    rawPayload: {
      fixtureVersion: "fake-job-discovery-v1",
      sourceId,
      detailId,
      company,
      title,
      location,
      industry,
      postedAt,
      description: `${company} 的虚构岗位夹具，仅用于本地确定性测试。`,
    },
  };
}

function summary(item: Fixture) {
  return {
    sourceId: item.sourceId,
    detailId: item.detailId,
    company: item.company,
    title: item.title,
    location: item.location,
    postedAt: item.postedAt,
    deadline: item.deadline,
  };
}

function matchesTarget(item: Fixture, target: DiscoverySearchInput["targetSnapshot"]): boolean {
  const { constraints } = target;
  const role = constraints.roleFamily.trim().toLocaleLowerCase("zh-CN");
  const title = item.title.toLocaleLowerCase("zh-CN");
  if (role && !title.includes(role)) return false;
  if (constraints.locations.length > 0 && !constraints.locations.includes(item.location)) return false;
  if (constraints.industries.length > 0 && !constraints.industries.includes(item.industry)) return false;
  if (constraints.dealBreakers.excludedCompanies.includes(item.company)) return false;
  if (constraints.dealBreakers.excludedIndustries.includes(item.industry)) return false;
  return true;
}

export class FakeJobDiscoveryAdapter implements JobDiscoveryAdapter {
  readonly adapter = "fake";
  readonly adapterVersion = "fake-job-discovery-v1";
  constructor(private readonly options: FakeJobDiscoveryAdapterOptions = {}) {}

  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration {
    return declareFormalBetaSourceCapabilities({ sourceId: input.sourceId, adapter: this.adapter, adapterVersion: this.adapterVersion });
  }

  async search(input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    await this.delay();
    const failure = this.options.failures?.search;
    if (failure) return { ok: false, error: failure };
    const match = fixtures.find((item) => item.sourceId === input.sourceId && matchesTarget(item, input.targetSnapshot));
    return match
      ? { ok: true, data: summary(match) }
      : { ok: false, error: { code: "FAKE_JOB_SEARCH_EMPTY", retryable: false } };
  }

  async searchBatch(input: DiscoveryBatchSearchInput): Promise<DiscoveryBatchSearchResult> {
    await this.delay();
    const failure = this.options.failures?.searchBatch;
    if (failure) return { ok: false, error: failure };
    const sourceOrder = new Map<string, number>(input.sourceScope.sources.map((sourceId, index) => [sourceId, index]));
    const data = fixtures
      .filter((item) => sourceOrder.has(item.sourceId) && matchesTarget(item, input.targetSnapshot))
      .sort((left, right) => {
        const sourceDifference = sourceOrder.get(left.sourceId)! - sourceOrder.get(right.sourceId)!;
        return sourceDifference || left.detailId.localeCompare(right.detailId);
      })
      .slice(0, AGENT_RUN_BUDGET.maxResults)
      .map(summary);
    return {
      ok: true,
      data: {
        items: data,
        sourceReceipts: input.sourceScope.sources.map((sourceId) => ({
          sourceId,
          checked: true as const,
          candidateCount: data.filter((item) => item.sourceId === sourceId).length,
        })),
      },
    };
  }

  async getDetail(input: DiscoveryDetailInput): Promise<DiscoveryDetailResult> {
    await this.delay();
    const failure = this.options.failures?.getDetail;
    if (failure) return { ok: false, error: failure };
    const match = fixtures.find((item) => item.sourceId === input.sourceId && item.detailId === input.detailId);
    return match
      ? { ok: true, data: { ...summary(match), sourceType: "company_careers", isOfficial: true, rawPayload: { ...match.rawPayload } } }
      : { ok: false, error: { code: "FAKE_JOB_DETAIL_NOT_FOUND", retryable: false } };
  }

  private async delay(): Promise<void> {
    if (!this.options.delayMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.options.delayMs));
  }
}
