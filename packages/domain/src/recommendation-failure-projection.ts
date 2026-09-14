import type { RecommendationRunFailureCode, RecommendationRunFailureSuggestedAction, RecommendationRunStageKey } from "@job-copilot/contracts/recommendation-runs";

export type RecommendationFailureProjection = {
  code: RecommendationRunFailureCode;
  stage: RecommendationRunStageKey;
  summary: string;
  basis: string;
  impact: string;
  suggestedAction: string;
  retryable: boolean;
  suggestedActions: RecommendationRunFailureSuggestedAction[];
};

export function projectRecommendationFailure(input: { failureCode: RecommendationRunFailureCode; stage: RecommendationRunStageKey; hasSourceCapabilityDiagnosis?: boolean }): RecommendationFailureProjection {
  const common = { code: input.failureCode, stage: input.stage };
  if (input.failureCode === "AGENT_RUN_ADAPTER_RETRYABLE" || input.failureCode === "AGENT_RUN_MODEL_RETRYABLE") return {
    ...common, summary: "推荐运行暂时无法完成。", basis: "运行遇到暂时性服务故障。", impact: "本次推荐尚未生成可用结果。", suggestedAction: "可重新开始完整推荐。", retryable: true, suggestedActions: ["restart_discovery"],
  };
  if (input.failureCode === "AGENT_RUN_MODEL_AUTH_FAILED" || input.failureCode === "AGENT_RUN_MODEL_POLICY_REJECTED" || input.failureCode === "AGENT_RUN_MODEL_INVALID_RESPONSE") return {
    ...common, summary: "推荐运行需要检查模型连接。", basis: "模型连接或输出诊断未通过。", impact: "本次推荐尚未生成可用结果。", suggestedAction: "请先检查模型连接诊断。", retryable: false, suggestedActions: ["run_model_diagnostic"],
  };
  if (input.failureCode === "AGENT_RUN_BUDGET_EXCEEDED") return {
    ...common, summary: "推荐运行预算已用尽。", basis: "本次运行达到已配置的预算上限。", impact: "本次推荐已停止，未生成可用结果。", suggestedAction: "请检查账户运行策略。", retryable: false, suggestedActions: ["review_account_run_policy"],
  };
  if (input.failureCode === "AGENT_RUN_ADAPTER_FAILED" && input.hasSourceCapabilityDiagnosis) return {
    ...common, summary: "推荐运行需要检查来源设置。", basis: "本次物理运行记录了来源能力诊断。", impact: "本次推荐尚未生成可用结果。", suggestedAction: "请查看来源健康状态。", retryable: false, suggestedActions: ["review_source_health"],
  };
  if (input.failureCode === "AGENT_RUN_PERSIST_FAILED" || input.failureCode === "RECOMMENDATION_PUBLICATION_FAILED") return {
    ...common, summary: "推荐结果暂未完成发布。", basis: "结果发布未完成且没有可安全重试的依据。", impact: "本次推荐尚未生成可用结果。", suggestedAction: "请标记为已处理，并在准备好后重新发起推荐。", retryable: false, suggestedActions: [],
  };
  return {
    ...common, summary: "推荐运行未能完成。", basis: "没有足够的稳定诊断支持直接重试。", impact: "本次推荐尚未生成可用结果。", suggestedAction: "请标记为已处理，并检查运行环境后再发起推荐。", retryable: false, suggestedActions: [],
  };
}
