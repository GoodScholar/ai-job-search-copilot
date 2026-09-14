import { getJobTargets } from "@/lib/server/job-targets";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import Link from "next/link";
import type { CalibrationProposal, RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";
import { getLatestPublishedRecommendationRun, getRecommendationRun } from "@/lib/server/recommendation-runs";
import { getCalibrationProposals, getLatestRecommendations, getRecommendationHistoryPage, getRecommendationList } from "@/lib/server/recommendations";
import { DeepMatchAssessmentSchema } from "@job-copilot/contracts/deep-match";
import { rebaseCalibrationProposalAction, recordRecommendationDecisionAction, requestRecommendationReevaluationAction, resolveCalibrationProposalAction, reviseCalibrationProposalAction } from "./actions";
import { RecommendationDecision } from "./recommendation-decision";
import { CalibrationProposals } from "./calibration-proposals";
import { ReevaluationForm } from "./reevaluate-button";
import { RecommendationHistory } from "./recommendation-history";
import { LatestExclusions } from "./latest-exclusions";
import { formatBand, formatDimensionDetail, formatDimensionLabel, formatEvidence, formatProfileEvidence } from "./formatters";
import { RecommendationResultSummary } from "./recommendation-result-summary";


export default async function RecommendationsPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const params = await searchParams;
  const only = (key: string) => typeof params[key] === "string" && params[key] !== "" && z.uuid().safeParse(params[key]).success ? params[key] : null;
  const runId = only("runId"), resultId = only("resultId"), targetParam = only("targetId"), listParam = only("recommendationListId");
  const has = (key: string) => Object.hasOwn(params, key);
  const identityKeys = ["runId", "resultId", "targetId", "recommendationListId"];
  const invalid = identityKeys.some((key) => has(key) && only(key) === null) || (has("resultId") && !runId) || (runId && (has("targetId") || has("recommendationListId"))) || (has("recommendationListId") && !targetParam);
  if (invalid) return <main className="container workbench-page" id="main-content"><section className="job-import-panel"><h1>推荐清单</h1><p role="alert">推荐链接无效，请从推荐通知或历史版本重新打开。</p></section></main>;
  let selectedRun = null, published = null, readError = false;
  let resultError: string | null = null;
  try { selectedRun = runId ? await getRecommendationRun(runId) : null; published = runId ? selectedRun : targetParam ? null : await getLatestPublishedRecommendationRun(); } catch (error) { unstable_rethrow(error); readError = true; resultError = "推荐结果暂时无法读取，请稍后重试。"; }
  const targets = !runId && !published && !targetParam && !readError ? await getJobTargets() : null;
  const targetId = targetParam ?? published?.target.targetId ?? targets?.targets.find((item) => item.state === "active" && item.priority === "primary")?.targetId ?? null;
  const result = published?.result ?? null;
  if (!resultError && runId && (!selectedRun || selectedRun.runId !== runId || (resultId && result?.resultId !== resultId))) resultError = "该推荐结果无法确认，请从推荐通知重新打开。";
  const runStatus = !resultError && runId && selectedRun && !result ? selectedRun.status === "queued" ? "推荐正在等待开始" : selectedRun.status === "running" ? "推荐正在进行" : selectedRun.status === "paused" ? "推荐已暂停，等待恢复" : selectedRun.status === "failed" ? selectedRun.failure?.summary ?? "本次推荐未能完成" : selectedRun.status === "cancelled" ? "本次推荐已取消" : null : null;
  const exactList = Boolean((result?.kind === "recommendation_list" && targetId) || (targetParam && listParam));
  let list = null;
  if (!resultError && !runStatus) try { list = result?.kind === "recommendation_list" && targetId ? await getRecommendationList(targetId, result.recommendationListId) : targetParam && listParam ? await getRecommendationList(targetParam, listParam) : targetParam ? await getLatestRecommendations(targetParam) : null; } catch (error) { unstable_rethrow(error); readError = true; resultError = exactList && typeof error === "object" && error !== null && "status" in error && error.status === 404 ? "推荐结果无法确认，请从推荐通知或历史版本重新打开。" : "推荐结果暂时无法读取，请稍后重试。"; }
  if (!readError && (!list && exactList || list && ((targetParam && list.targetId !== targetParam) || (listParam && list.recommendationListId !== listParam) || (result?.kind === "recommendation_list" && (list.targetId !== targetId || list.recommendationListId !== result.recommendationListId))))) { resultError = "推荐结果无法确认，请从推荐通知或历史版本重新打开。"; list = null; }
  let history: RecommendationListHistoryPage = { items: [], nextCursor: null }, proposals: CalibrationProposal[] = [], sideReadError: string | null = null;
  if (targetId && !resultError) try { history = await getRecommendationHistoryPage(targetId); } catch (error) { unstable_rethrow(error); sideReadError = "历史记录暂时无法读取，请稍后重试。"; }
  if (targetId && !resultError) try { proposals = await getCalibrationProposals(targetId); } catch (error) { unstable_rethrow(error); sideReadError ??= "校准建议暂时无法读取，请稍后重试。"; }
  return (
    <main className="container workbench-page" id="main-content">
      <section aria-labelledby="recommendations-title" className="job-import-panel">
        <p className="section-kicker">今日处理</p>
        <h1 id="recommendations-title">推荐清单</h1>
        <p>系统会从通过资格门槛的岗位中整理少量推荐，并保留每项判断的岗位与画像证据。</p>
        {resultError ? <p role="alert">{resultError}</p> : result ? <RecommendationResultSummary result={result} /> : null}
        {sideReadError ? <p role="alert">{sideReadError}</p> : null}
        {runStatus ? <><h2>{runStatus}</h2><Link className="workbench-touch-target" href={`/home?runId=${runId}`}>查看本次推荐</Link></> : null}
        {!list && !result && !resultError && !runStatus ? <><h2>暂无可处理的推荐</h2><p>完成岗位发现和资格筛选后，这里会显示高度匹配、值得尝试或谨慎考虑的岗位。</p></> : list ? <>
          <p aria-label="推荐清单版本">清单版本 {list.sequence} · {list.localDate}</p>
          <LatestExclusions key={list.recommendationListId} targetId={targetId!} list={list} />
          <RecommendationHistory key={`${targetId!}:${history.items.map((item) => item.recommendationListId).join(",")}:${history.nextCursor ?? ""}`} targetId={targetId!} initialPage={history} />
          <CalibrationProposals proposals={proposals} reviseAction={reviseCalibrationProposalAction} rebaseAction={rebaseCalibrationProposalAction} resolveAction={resolveCalibrationProposalAction} />
          <ol aria-label="推荐岗位" id="recommendation-list">
            {list.items.map((item) => {
              const assessment = DeepMatchAssessmentSchema.safeParse(item.assessment).data;
              return <li key={item.matchVersionId}><h2>{item.title ?? "岗位机会"}</h2><p>{item.company ?? "来源待确认"} · {item.location ?? "地点待确认"} · <strong>{formatBand(item.displayBand)}</strong></p>{item.highlighted ? <p><strong>今日优先处理</strong></p> : null}<RecommendationDecision item={item} action={recordRecommendationDecisionAction.bind(null, list.recommendationListId, item.recommendationListItemId ?? "")} /><ReevaluationForm action={requestRecommendationReevaluationAction.bind(null, targetId!, item.opportunityId)} /><details><summary className="workbench-touch-target">查看证据与判断</summary><p>匹配版本：{item.matchVersionId}</p><p>岗位证据：{formatEvidence(item.jobEvidence)}</p><p>画像证据：{formatProfileEvidence(item.profileEvidence)}</p>{assessment?.dimensions.map((dimension) => <p key={dimension.dimension}><strong>{formatDimensionLabel(dimension)}</strong>：{formatDimensionDetail(dimension)}</p>)}</details></li>;
            })}
          </ol>
        </> : null}
        {!list && targetId && !resultError ? <RecommendationHistory key={`${targetId}:${history.items.map((item) => item.recommendationListId).join(",")}:${history.nextCursor ?? ""}`} targetId={targetId} initialPage={history} /> : null}
      </section>
    </main>
  );
}
