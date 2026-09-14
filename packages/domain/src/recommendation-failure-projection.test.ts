import { describe, expect, it } from "vitest";
import { projectRecommendationFailure } from "./recommendation-failure-projection";

describe("推荐失败安全投影", () => {
  it("只将暂时性模型故障投影为可直接重试", () => {
    expect(projectRecommendationFailure({ failureCode: "AGENT_RUN_MODEL_RETRYABLE", stage: "deep_matching" })).toMatchObject({
      retryable: true, suggestedActions: ["restart_discovery"], summary: "推荐运行暂时无法完成。",
    });
  });

  it("将模型鉴权和未知持久化故障保守地投影为不可重试", () => {
    expect(projectRecommendationFailure({ failureCode: "AGENT_RUN_MODEL_AUTH_FAILED", stage: "discovery" })).toMatchObject({
      retryable: false, suggestedActions: ["run_model_diagnostic"], summary: "推荐运行需要检查模型连接。",
    });
    expect(projectRecommendationFailure({ failureCode: "AGENT_RUN_PERSIST_FAILED", stage: "result_publication" })).toMatchObject({
      retryable: false, suggestedActions: [], summary: "推荐结果暂未完成发布。",
    });
  });

  it("只有持久化证明的来源能力问题才引导查看来源", () => {
    expect(projectRecommendationFailure({ failureCode: "AGENT_RUN_ADAPTER_FAILED", stage: "discovery", hasSourceCapabilityDiagnosis: true })).toMatchObject({
      retryable: false, suggestedActions: ["review_source_health"],
    });
    expect(projectRecommendationFailure({ failureCode: "AGENT_RUN_ADAPTER_FAILED", stage: "discovery" })).toMatchObject({
      retryable: false, suggestedActions: [],
    });
  });
});
