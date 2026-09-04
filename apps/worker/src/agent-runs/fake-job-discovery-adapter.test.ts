import { describe, expect, it } from "vitest";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";

import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";

const targetSnapshot = {
  targetId: "10000000-0000-4000-8000-000000000001",
  version: 1,
  priority: "primary",
  state: "active",
  constraints: {
    roleFamily: "工程师",
    seniority: null,
    locations: [],
    workModes: [],
    relocation: "unknown",
    salary: null,
    industries: [],
    dealBreakers: {
      excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false,
      excludeDispatch: false, excludeHeadhunter: false, other: [],
    },
  },
} satisfies AgentRunDetail["targetSnapshot"];

describe("FakeJobDiscoveryAdapter", () => {
  it("按单一来源和目标约束返回确定性的第一条摘要", async () => {
    const adapter = new FakeJobDiscoveryAdapter();
    const result = await adapter.search({
      targetSnapshot: {
        ...targetSnapshot,
        constraints: { ...targetSnapshot.constraints, roleFamily: "高级前端工程师", locations: ["上海"] },
      },
      sourceId: "fake:aurora-careers",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        sourceId: "fake:aurora-careers",
        detailId: "aurora-frontend-001",
        company: "曙光云图",
        title: "高级前端工程师",
        location: "上海",
        postedAt: "2026-08-20T00:00:00.000Z",
        deadline: null,
      },
    });
  });

  it("批量搜索按稳定来源身份排序、应用目标过滤并最多返回五条", async () => {
    const adapter = new FakeJobDiscoveryAdapter();
    const broad = await adapter.searchBatch({
      targetSnapshot,
      sourceScope: {
        kind: "company_watchlist",
        adapter: "fake",
        adapterVersion: "fake-job-discovery-v1",
        watchlistVersion: 0,
        sources: ["fake:aurora-careers", "fake:orbit-careers"],
      },
    });
    const filtered = await adapter.searchBatch({
      targetSnapshot: {
        ...targetSnapshot,
        constraints: { ...targetSnapshot.constraints, roleFamily: "AI 应用工程师", locations: ["深圳"] },
      },
      sourceScope: {
        kind: "company_watchlist",
        adapter: "fake",
        adapterVersion: "fake-job-discovery-v1",
        watchlistVersion: 0,
        sources: ["fake:aurora-careers", "fake:orbit-careers"],
      },
    });

    expect(broad).toMatchObject({ ok: true });
    if (!broad.ok) throw new Error("expected successful fake search");
    expect(broad.data).toHaveLength(5);
    expect(broad.data.map(({ sourceId, detailId }) => `${sourceId}/${detailId}`)).toEqual([
      "fake:aurora-careers/aurora-ai-001",
      "fake:aurora-careers/aurora-frontend-001",
      "fake:aurora-careers/aurora-fullstack-001",
      "fake:orbit-careers/orbit-agent-001",
      "fake:orbit-careers/orbit-ai-001",
    ]);
    expect(filtered).toEqual({
      ok: true,
      data: [expect.objectContaining({ sourceId: "fake:orbit-careers", detailId: "orbit-ai-001", location: "深圳" })],
    });
  });

  it("对任意 Watchlist URL 安全返回零结果，且保留 fake 夹具和快照来源顺序", async () => {
    const adapter = new FakeJobDiscoveryAdapter();
    const customUrl = "https://careers.example.test/openings";

    await expect(adapter.searchBatch({
      targetSnapshot,
      sourceScope: {
        kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 2,
        sources: [customUrl],
      },
    })).resolves.toEqual({ ok: true, data: [] });

    const mixed = await adapter.searchBatch({
      targetSnapshot,
      sourceScope: {
        kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 2,
        sources: [customUrl, "fake:orbit-careers", "fake:aurora-careers"],
      },
    });
    expect(mixed).toMatchObject({ ok: true });
    if (!mixed.ok) throw new Error("expected successful fake search");
    expect(mixed.data.map(({ sourceId, detailId }) => `${sourceId}/${detailId}`)).toEqual([
      "fake:orbit-careers/orbit-agent-001",
      "fake:orbit-careers/orbit-ai-001",
      "fake:orbit-careers/orbit-platform-001",
      "fake:aurora-careers/aurora-ai-001",
      "fake:aurora-careers/aurora-frontend-001",
    ]);
  });

  it("读取规范化详情，并把未知来源身份作为不可重试错误", async () => {
    const adapter = new FakeJobDiscoveryAdapter();

    await expect(adapter.getDetail({ sourceId: "fake:orbit-careers", detailId: "orbit-agent-001" }))
      .resolves.toEqual({
        ok: true,
        data: expect.objectContaining({
          sourceId: "fake:orbit-careers",
          detailId: "orbit-agent-001",
          sourceType: "company_careers",
          isOfficial: true,
          rawPayload: expect.objectContaining({ fixtureVersion: "fake-job-discovery-v1" }),
        }),
      });
    await expect(adapter.getDetail({ sourceId: "fake:orbit-careers", detailId: "missing" }))
      .resolves.toEqual({ ok: false, error: { code: "FAKE_JOB_DETAIL_NOT_FOUND", retryable: false } });
  });

  it("每次读取返回隔离的原始夹具，调用方修改不会污染后续结果", async () => {
    const adapter = new FakeJobDiscoveryAdapter();
    const input = { sourceId: "fake:orbit-careers", detailId: "orbit-agent-001" };
    const first = await adapter.getDetail(input);
    if (!first.ok) throw new Error("expected known fixture");
    first.data.rawPayload.title = "被调用方修改";

    const second = await adapter.getDetail(input);
    expect(second).toMatchObject({ ok: true, data: { rawPayload: { title: "Agent 工程师" } } });
  });

  it("仅通过构造器显式注入可重试或不可重试故障", async () => {
    const retryable = new FakeJobDiscoveryAdapter({
      failures: { searchBatch: { code: "FAKE_SOURCE_TEMPORARILY_UNAVAILABLE", retryable: true } },
    });
    const nonretryable = new FakeJobDiscoveryAdapter({
      failures: { getDetail: { code: "FAKE_SOURCE_REJECTED", retryable: false } },
    });

    await expect(retryable.searchBatch({
      targetSnapshot,
      sourceScope: {
        kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
        watchlistVersion: 0,
        sources: ["fake:aurora-careers", "fake:orbit-careers"],
      },
    })).resolves.toEqual({ ok: false, error: { code: "FAKE_SOURCE_TEMPORARILY_UNAVAILABLE", retryable: true } });
    await expect(nonretryable.getDetail({ sourceId: "fake:aurora-careers", detailId: "aurora-ai-001" }))
      .resolves.toEqual({ ok: false, error: { code: "FAKE_SOURCE_REJECTED", retryable: false } });

    const ordinaryText = await new FakeJobDiscoveryAdapter().search({
      targetSnapshot: {
        ...targetSnapshot,
        constraints: { ...targetSnapshot.constraints, roleFamily: "FAKE_SOURCE_TEMPORARILY_UNAVAILABLE" },
      },
      sourceId: "fake:aurora-careers",
    });
    expect(ordinaryText).toEqual({ ok: false, error: { code: "FAKE_JOB_SEARCH_EMPTY", retryable: false } });
  });
});
