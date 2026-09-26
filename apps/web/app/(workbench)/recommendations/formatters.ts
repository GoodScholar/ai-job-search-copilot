import type { DeepMatchAssessment } from "@job-copilot/contracts/deep-match";
import type { RecommendationList } from "@job-copilot/contracts/recommendations";

const bandText = { highly_matched: "高度匹配", worth_trying: "值得尝试", consider_carefully: "谨慎考虑" } as const;
const dimensionText = { skills: "技能", experience: "经验", project_depth: "项目深度", career_direction: "岗位方向", location_logistics: "地点与工作方式", qualification_risk: "资格风险" } as const;

export function formatBand(band: RecommendationList["items"][number]["displayBand"]) { return bandText[band]; }
export function formatEvidence(evidence: RecommendationList["items"][number]["jobEvidence"]) { return evidence.map((item) => item.provenance ? `${item.provenance.path}：${item.provenance.originalValue}` : item.value).join("；"); }
export function formatProfileEvidenceValue(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      if ("name" in parsed && typeof parsed.name === "string") return "level" in parsed && typeof parsed.level === "string" && parsed.level ? `${parsed.name} · ${parsed.level}` : parsed.name;
      if ("summary" in parsed && typeof parsed.summary === "string") return parsed.summary;
    }
  } catch { /* frozen target evidence is plain text. */ }
  return value.replace(/\bremote\b/g, "远程").replace(/\bnot_willing\b/g, "不可搬迁").replace(/,\s*/g, "、");
}
export function formatProfileEvidence(evidence: RecommendationList["items"][number]["profileEvidence"]) { return evidence.map((item) => formatProfileEvidenceValue(item.value)).join("；"); }
export function formatDimensionLabel(dimension: DeepMatchAssessment["dimensions"][number]) { return dimensionText[dimension.dimension]; }
export function formatDimensionDetail(dimension: DeepMatchAssessment["dimensions"][number]) { return `${dimension.judgment === "evidence_backed_inference" ? "证据支持的推断" : "证据不足"}；${dimension.summary}`; }
