import { describe, expect, it } from "vitest";
import { projectRecommendationRun } from "./recommendation-runs";

describe("推荐运行投影", () => {
  it("将根发现完成和子运行中的持久步骤投影为深度匹配阶段", () => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: true,
      selectionCompleted: true,
      child: { status: "running", steps: ["completed", "running", "pending"] },
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "completed" },
      { key: "coarse_ranking", status: "completed" },
      { key: "deep_matching", status: "running" },
      { key: "result_publication", status: "pending" },
    ]);
  });

  it("根运行完成但未持久化子运行时不把交接缺失伪装为运行中", () => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: false,
      selectionCompleted: false,
      child: null,
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "failed" },
      { key: "coarse_ranking", status: "pending" },
      { key: "deep_matching", status: "pending" },
      { key: "result_publication", status: "pending" },
    ]);
  });
});
