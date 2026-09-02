import { randomUUID } from "node:crypto";
import type { RecommendationList } from "@job-copilot/contracts/recommendations";

const reasons = [
  ["ROLE_DIRECTION", "岗位方向"], ["LOCATION", "地点"], ["SALARY", "薪资"], ["COMPANY", "公司"], ["INDUSTRY", "行业"], ["SENIORITY", "职级"], ["MISMATCH", "不匹配"], ["EXPIRED", "已过期"], ["ALREADY_HANDLED", "已处理"],
] as const;

export function RecommendationDecision({ item, action }: { item: RecommendationList["items"][number]; action: (formData: FormData) => Promise<void> }) {
  const decision = item.decision ?? { status: "pending" as const, version: 0 };
  if (!item.recommendationListItemId) return null;
  return <section aria-label="推荐决策" className="flex flex-col gap-3"><p>当前推荐决策：<strong>{decision.status === "pending" ? "待查看" : decision.status === "saved" ? "已收藏" : "已忽略"}</strong></p>
    <form action={action} className="flex flex-wrap gap-2"><input type="hidden" name="decision" value="saved" /><input type="hidden" name="expectedVersion" value={decision.version} /><input type="hidden" name="idempotencyKey" value={randomUUID()} /><button className="workbench-touch-target" type="submit">收藏</button></form>
    <details><summary className="workbench-touch-target">忽略此推荐</summary><form action={action} className="flex flex-col gap-3"><input type="hidden" name="decision" value="ignored" /><input type="hidden" name="expectedVersion" value={decision.version} /><input type="hidden" name="idempotencyKey" value={randomUUID()} /><fieldset><legend>忽略原因（可跳过）</legend><div className="flex flex-wrap gap-2">{reasons.map(([value, label]) => <label key={value}><input type="radio" name="reason" value={value} /> {label}</label>)}</div></fieldset><label>备注（可选，最多 500 字）<textarea name="note" maxLength={500} /></label><button className="workbench-touch-target" type="submit">确认忽略</button></form></details>
  </section>;
}
