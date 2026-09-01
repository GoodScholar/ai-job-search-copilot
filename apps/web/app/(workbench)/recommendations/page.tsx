import { getJobTargets } from "@/lib/server/job-targets";
import { getLatestRecommendations, getRecommendationHistory } from "@/lib/server/recommendations";
import { DeepMatchAssessmentSchema } from "@job-copilot/contracts/deep-match";
import { Button } from "@/components/ui/button";
import { requestRecommendationReevaluationAction } from "./actions";

const bandText = { highly_matched: "高度匹配", worth_trying: "值得尝试", consider_carefully: "谨慎考虑" } as const;

export default async function RecommendationsPage() {
  const targets = await getJobTargets();
  const target = targets.targets.find((item) => item.state === "active");
  const list = target ? await getLatestRecommendations(target.targetId) : null;
  const history = target ? await getRecommendationHistory(target.targetId) : [];
  return (
    <main className="container workbench-page" id="main-content">
      <section aria-labelledby="recommendations-title" className="job-import-panel">
        <p className="section-kicker">今日处理</p>
        <h1 id="recommendations-title">推荐清单</h1>
        <p>系统会从通过资格门槛的岗位中整理少量推荐，并保留每项判断的岗位与画像证据。</p>
        {!list ? <><h2>暂无可处理的推荐</h2><p>完成岗位发现和资格筛选后，这里会显示高度匹配、值得尝试或谨慎考虑的岗位。</p></> : <>
          <p aria-label="推荐清单版本">清单版本 {list.sequence} · {list.localDate}</p>
          {list.exclusions.length > 0 && <p>因匹配质量不足而排除 {list.exclusions.filter((item) => item.reasonCode === "MATCH_QUALITY_INSUFFICIENT").length} 项岗位</p>}
          <details><summary>历史版本</summary><ol>{history.map((version) => <li key={version.recommendationListId}><details><summary>清单版本 {version.sequence} · {version.localDate}</summary>{version.items.length === 0 ? <p>该版本没有可推荐岗位。</p> : <ol>{version.items.map((item) => <li key={item.matchVersionId}><strong>{item.title ?? "岗位机会"}</strong><p>岗位证据：{item.jobEvidence.map((evidence) => evidence.value).join("；")}</p><p>画像证据：{item.profileEvidence.map((evidence) => evidence.value).join("；")}</p></li>)}</ol>}{version.exclusions.length > 0 ? <p>稳定排除：{version.exclusions.map((item) => item.reasonCode).join("、")}</p> : null}</details></li>)}</ol></details>
          <ol aria-label="推荐岗位">
            {list.items.map((item) => {
              const assessment = DeepMatchAssessmentSchema.safeParse(item.assessment).data;
              return <li key={item.matchVersionId}><h2>{item.title ?? "岗位机会"}</h2><p>{item.company ?? "来源待确认"} · {item.location ?? "地点待确认"} · <strong>{bandText[item.displayBand]}</strong></p><form action={requestRecommendationReevaluationAction.bind(null, target!.targetId, item.opportunityId)}><Button className="workbench-touch-target" size="lg" type="submit">重新评估此岗位</Button></form><details><summary>查看证据与判断</summary><p>匹配版本：{item.matchVersionId}</p><p>岗位证据：{item.jobEvidence.map((evidence) => evidence.value).join("；")}</p><p>画像证据：{item.profileEvidence.map((evidence) => evidence.value).join("；")}</p>{assessment?.dimensions.map((dimension) => <p key={dimension.dimension}><strong>{dimension.judgment === "evidence_backed_inference" ? "证据支持的推断" : "证据不足"}</strong>：{dimension.summary}</p>)}</details></li>;
            })}
          </ol>
        </>}
      </section>
    </main>
  );
}
