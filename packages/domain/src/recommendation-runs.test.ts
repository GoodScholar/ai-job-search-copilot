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

  it("恢复后的 queued child 保留已开始的深度匹配阶段", () => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: true,
      selectionCompleted: true,
      child: { status: "queued", steps: ["completed", "pending", "pending"], started: true },
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "completed" },
      { key: "coarse_ranking", status: "completed" },
      { key: "deep_matching", status: "running" },
      { key: "result_publication", status: "pending" },
    ]);
  });

  it("将 create_recommendations 的执行投影到结果发布而不是深度匹配", () => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: true,
      selectionCompleted: true,
      child: { status: "running", steps: ["completed", "completed", "running"] },
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "completed" },
      { key: "coarse_ranking", status: "completed" },
      { key: "deep_matching", status: "completed" },
      { key: "result_publication", status: "running" },
    ]);
  });

  it.each(["failed", "cancelled"] as const)("create_recommendations %s 时保留已完成深度匹配并终止发布阶段", (status) => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: true,
      selectionCompleted: true,
      child: { status, steps: ["completed", "completed", "failed"] },
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "completed" },
      { key: "coarse_ranking", status: "completed" },
      { key: "deep_matching", status: "completed" },
      { key: "result_publication", status },
    ]);
  });

  it("child 已完成而无 immutable result 时投影稳定发布失败", () => {
    expect(projectRecommendationRun({
      root: { status: "completed", steps: ["completed", "completed", "completed"] },
      qualificationCompleted: true,
      selectionCompleted: true,
      child: { status: "completed", steps: ["completed", "completed", "completed"] },
      resultPublished: false,
    })).toEqual([
      { key: "discovery", status: "completed" },
      { key: "qualification", status: "completed" },
      { key: "coarse_ranking", status: "completed" },
      { key: "deep_matching", status: "completed" },
      { key: "result_publication", status: "failed" },
    ]);
  });
});
