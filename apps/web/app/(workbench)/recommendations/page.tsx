import { getJobTargets } from "@/lib/server/job-targets";
import { getCalibrationProposals, getLatestRecommendations, getRecommendationHistoryPage } from "@/lib/server/recommendations";
import { DeepMatchAssessmentSchema } from "@job-copilot/contracts/deep-match";
import { recordRecommendationDecisionAction, requestRecommendationReevaluationAction, resolveCalibrationProposalAction, reviseCalibrationProposalAction } from "./actions";
import { RecommendationDecision } from "./recommendation-decision";
import { CalibrationProposals } from "./calibration-proposals";
import { ReevaluationForm } from "./reevaluate-button";
import { RecommendationHistory } from "./recommendation-history";
import { LatestExclusions } from "./latest-exclusions";
import { formatBand, formatDimensionDetail, formatDimensionLabel, formatEvidence, formatProfileEvidence } from "./formatters";


export default async function RecommendationsPage() {
  const targets = await getJobTargets();
  const target = targets.targets.find((item) => item.state === "active");
  const list = target ? await getLatestRecommendations(target.targetId) : null;
  const history = target ? await getRecommendationHistoryPage(target.targetId) : { items: [], nextCursor: null };
  const proposals = target ? await getCalibrationProposals(target.targetId) : [];
  return (
    <main className="container workbench-page" id="main-content">
      <section aria-labelledby="recommendations-title" className="job-import-panel">
        <p className="section-kicker">今日处理</p>
        <h1 id="recommendations-title">推荐清单</h1>
        <p>系统会从通过资格门槛的岗位中整理少量推荐，并保留每项判断的岗位与画像证据。</p>
        {!list ? <><h2>暂无可处理的推荐</h2><p>完成岗位发现和资格筛选后，这里会显示高度匹配、值得尝试或谨慎考虑的岗位。</p></> : <>
          <p aria-label="推荐清单版本">清单版本 {list.sequence} · {list.localDate}</p>
          <LatestExclusions key={list.recommendationListId} targetId={target!.targetId} list={list} />
          <RecommendationHistory key={`${target!.targetId}:${history.items.map((item) => item.recommendationListId).join(",")}:${history.nextCursor ?? ""}`} targetId={target!.targetId} initialPage={history} />
          <CalibrationProposals proposals={proposals} reviseAction={reviseCalibrationProposalAction} resolveAction={resolveCalibrationProposalAction} />
          <ol aria-label="推荐岗位">
            {list.items.map((item) => {
              const assessment = DeepMatchAssessmentSchema.safeParse(item.assessment).data;
              return <li key={item.matchVersionId}><h2>{item.title ?? "岗位机会"}</h2><p>{item.company ?? "来源待确认"} · {item.location ?? "地点待确认"} · <strong>{formatBand(item.displayBand)}</strong></p>{item.highlighted ? <p><strong>今日优先处理</strong></p> : null}<RecommendationDecision item={item} action={recordRecommendationDecisionAction.bind(null, list.recommendationListId, item.recommendationListItemId ?? "")} /><ReevaluationForm action={requestRecommendationReevaluationAction.bind(null, target!.targetId, item.opportunityId)} /><details><summary className="workbench-touch-target">查看证据与判断</summary><p>匹配版本：{item.matchVersionId}</p><p>岗位证据：{formatEvidence(item.jobEvidence)}</p><p>画像证据：{formatProfileEvidence(item.profileEvidence)}</p>{assessment?.dimensions.map((dimension) => <p key={dimension.dimension}><strong>{formatDimensionLabel(dimension)}</strong>：{formatDimensionDetail(dimension)}</p>)}</details></li>;
            })}
          </ol>
        </>}
      </section>
    </main>
  );
}
