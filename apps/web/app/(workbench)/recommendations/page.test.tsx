import { render, screen } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getJobTargets: vi.fn(), getLatestRecommendations: vi.fn(), getRecommendationHistoryPage: vi.fn() }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/recommendations", () => ({ getLatestRecommendations: mocks.getLatestRecommendations, getRecommendationHistoryPage: mocks.getRecommendationHistoryPage }));
vi.mock("./actions", () => ({ requestRecommendationReevaluationAction: vi.fn() }));
import RecommendationsPage from "./page";

describe("RecommendationsPage", () => {
  beforeEach(() => {
    mocks.getJobTargets.mockResolvedValue({ targets: [] });
    mocks.getLatestRecommendations.mockResolvedValue(null);
    mocks.getRecommendationHistoryPage.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("explains the evidence-driven recommendation state without exposing a precise score", async () => {
    render(await RecommendationsPage());
    expect(screen.getByRole("heading", { name: "推荐清单" })).toBeInTheDocument();
    expect(screen.getByText("暂无可处理的推荐")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("展示证据判断、历史版本入口和异步重新评估入口，但不展示精确分数", async () => {
    mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: "00000000-0000-4000-8000-000000000001", state: "active" }] });
    mocks.getLatestRecommendations.mockResolvedValue({
      recommendationListId: "10000000-0000-4000-8000-000000000001", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-09-01", sequence: 2, createdAt: "2026-09-01T00:00:00.000Z",
      exclusions: [{ opportunityId: "30000000-0000-4000-8000-000000000099", reasonCode: "MATCH_QUALITY_INSUFFICIENT" }],
      items: [{ matchVersionId: "20000000-0000-4000-8000-000000000001", opportunityId: "30000000-0000-4000-8000-000000000001", company: "示例科技", title: "前端工程师", location: "上海", displayBand: "highly_matched", highlighted: true, ordinal: 1, jobEvidence: [{ id: "job:1", value: "岗位要求 TypeScript" }], profileEvidence: [{ id: "profile:1", value: "已确认 TypeScript 经历" }], assessment: { opportunityId: "30000000-0000-4000-8000-000000000001", overallScore: 80, dimensions: ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"].map((dimension) => ({ dimension, score: 80, judgment: "evidence_backed_inference", jobEvidenceIds: ["job:1"], profileEvidenceIds: ["profile:1"], summary: dimension === "skills" ? "岗位要求与已确认技能相符。" : "证据支持的推断。" })) } }],
    });
    mocks.getRecommendationHistoryPage.mockResolvedValue({ items: [{
      recommendationListId: "10000000-0000-4000-8000-000000000000", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-08-31", sequence: 1, createdAt: "2026-08-31T00:00:00.000Z", exclusions: [],
      items: [{ matchVersionId: "20000000-0000-4000-8000-000000000000", opportunityId: "30000000-0000-4000-8000-000000000000", company: "历史公司", title: "历史岗位", location: "上海", displayBand: "worth_trying", highlighted: true, ordinal: 1, jobEvidence: [{ id: "job:old", value: "历史岗位证据" }], profileEvidence: [{ id: "profile:old", value: "历史画像证据" }], assessment: { opportunityId: "30000000-0000-4000-8000-000000000000", overallScore: 70, dimensions: ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"].map((dimension) => ({ dimension, score: 70, judgment: "evidence_backed_inference", jobEvidenceIds: ["job:old"], profileEvidenceIds: ["profile:old"], summary: "历史证据支持的推断。" })) } }],
    }], nextCursor: null });

    render(await RecommendationsPage());
    expect(screen.getByText("高度匹配")).toBeInTheDocument();
    expect(screen.getByText("今日优先处理")).toBeInTheDocument();
    expect(screen.getByText(/岗位要求与已确认技能相符/u)).toBeInTheDocument();
    expect(screen.getByText(/岗位证据：岗位要求 TypeScript/u)).toBeInTheDocument();
    expect(screen.getByText(/画像证据：已确认 TypeScript 经历/u)).toBeInTheDocument();
    expect(screen.getByText(/稳定排除 1 项岗位：MATCH_QUALITY_INSUFFICIENT/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新评估此岗位" })).toBeInTheDocument();
    expect(screen.getByLabelText("推荐清单版本")).toHaveTextContent("清单版本 2");
    expect(screen.getByText("历史版本")).toBeInTheDocument();
    expect(screen.getByText("历史岗位")).toBeInTheDocument();
    expect(screen.getByText(/历史岗位证据/u)).toBeInTheDocument();
    expect(screen.queryByText("总体分数")).not.toBeInTheDocument();
  });
});
