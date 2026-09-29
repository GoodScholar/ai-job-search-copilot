import { JobQualificationsSchema } from "@job-copilot/contracts/job-imports";
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
  firstRecommendation?: boolean;
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
      company_name: company,
      title,
      location: { name: location },
      first_published: postedAt,
      application_deadline: null,
      content: [
        "为可验证的求职工作台交付 TypeScript 前端功能。",
        "工作方式：远程",
        "是否需要搬迁：否",
        "薪资：CNY 30000-45000/month",
        "学历：本科",
        "语言：英语(C1)",
        "工作资格：中国工作许可",
        `行业：${industry}`,
        "雇佣类型：直接雇佣",
        "必备技能：TypeScript",
      ].join("\n"),
    },
  };
}

// 仅由 test 环境的显式运行场景启用；字段及原文都标明合成测试来源。
const firstRecommendationQualifications = JobQualificationsSchema.parse({
  workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } },
  relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "搬迁", value: "否" } },
  salary: { value: { minimum: 30000, maximum: 45000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "CNY 30000-45000/month" } },
  seniority: null,
  education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } },
  languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } },
  workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } },
  industry: { value: "云计算", evidence: { field: "industry", path: "行业", value: "云计算" } },
  employmentType: { value: "direct", evidence: { field: "employmentType", path: "雇佣类型", value: "直接雇佣" } },
  requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "必备技能", value: "TypeScript" } },
});

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

  private get fixtures(): readonly Fixture[] {
    if (!this.options.firstRecommendation) return fixtures;
    return fixtures.filter((item) => item.detailId === "aurora-frontend-001").map((item) => ({
      ...item, company: "=合成验收公司", title: "高级前端工程师（合成验收）", deadline: "2030-12-31T00:00:00.000Z",
    }));
  }

  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration {
    return declareFormalBetaSourceCapabilities({ sourceId: input.sourceId, adapter: this.adapter, adapterVersion: this.adapterVersion });
  }

  async search(input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    await this.delay();
    const failure = this.options.failures?.search;
    if (failure) return { ok: false, error: failure };
    const match = this.fixtures.find((item) => item.sourceId === input.sourceId && matchesTarget(item, input.targetSnapshot));
    return match
      ? { ok: true, data: summary(match) }
      : { ok: false, error: { code: "FAKE_JOB_SEARCH_EMPTY", retryable: false } };
  }

  async searchBatch(input: DiscoveryBatchSearchInput): Promise<DiscoveryBatchSearchResult> {
    await this.delay();
    const failure = this.options.failures?.searchBatch;
    if (failure) return { ok: false, error: failure };
    const sourceOrder = new Map<string, number>(input.sourceScope.sources.map((sourceId, index) => [sourceId, index]));
    const matched = this.fixtures
      .filter((item) => sourceOrder.has(item.sourceId) && matchesTarget(item, input.targetSnapshot))
      .sort((left, right) => {
        const sourceDifference = sourceOrder.get(left.sourceId)! - sourceOrder.get(right.sourceId)!;
        return sourceDifference || left.detailId.localeCompare(right.detailId);
      });
    const data = matched.slice(0, AGENT_RUN_BUDGET.maxResults).map(summary);
    return {
      ok: true,
      data: {
        items: data,
        sourceReceipts: input.sourceScope.sources.map((sourceId) => ({
          sourceId,
          checked: true as const,
          candidateCount: data.filter((item) => item.sourceId === sourceId).length,
          budgetExcludedCount: matched.filter((item) => item.sourceId === sourceId).length - data.filter((item) => item.sourceId === sourceId).length,
        })),
      },
    };
  }

  async getDetail(input: DiscoveryDetailInput): Promise<DiscoveryDetailResult> {
    await this.delay();
    const failure = this.options.failures?.getDetail;
    if (failure) return { ok: false, error: failure };
    const match = this.fixtures.find((item) => item.sourceId === input.sourceId && item.detailId === input.detailId);
    return match
      ? { ok: true, data: { ...summary(match), sourceType: "company_careers", isOfficial: true, ...(this.options.firstRecommendation ? { description: "虚构岗位，仅用于确定性验收。", qualifications: firstRecommendationQualifications } : {}), rawPayload: this.options.firstRecommendation ? {
        ...match.rawPayload,
        company_name: match.company,
        title: match.title,
        location: { name: match.location },
        first_published: match.postedAt,
        application_deadline: match.deadline,
      } : { ...match.rawPayload } } }
      : { ok: false, error: { code: "FAKE_JOB_DETAIL_NOT_FOUND", retryable: false } };
  }

  private async delay(): Promise<void> {
    if (!this.options.delayMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.options.delayMs));
  }
}
