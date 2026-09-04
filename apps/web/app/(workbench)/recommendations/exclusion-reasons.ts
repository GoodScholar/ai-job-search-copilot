import type { RecommendationList } from "@job-copilot/contracts/recommendations";

export const exclusionReasonText: Record<RecommendationList["exclusions"][number]["reasonCode"], string> = {
  TRIAGE_NOT_PASS: "不符合岗位初筛条件",
  DEADLINE_EXPIRED: "岗位截止日期已过",
  SCORE_BELOW_THRESHOLD: "初步匹配度未达要求",
  CANDIDATE_LIMIT: "本次优先评估名额已满",
  MATCH_QUALITY_INSUFFICIENT: "匹配证据不足",
};
