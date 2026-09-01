import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { JobTarget } from "@job-copilot/contracts/job-targets";
import type { JobTriageVersion } from "@job-copilot/contracts/job-triage";
const mocks = vi.hoisted(() => ({ createJobTriageAction: vi.fn() }));
vi.mock("@/app/(workbench)/jobs/import/actions", () => ({ createJobTriageAction: mocks.createJobTriageAction }));
import { JobTriagePanel } from "./job-triage-panel";

const target: JobTarget = { targetId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", version: 1, priority: "primary", state: "active", constraints: { roleFamily: "前端工程师", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
const gates = Object.fromEntries(["location", "work_mode", "relocation", "salary", "seniority", "education", "language", "work_eligibility", "deal_breakers"].map((gate) => [gate, { verdict: "unknown", reasonCode: "JOB_EVIDENCE_MISSING", jobEvidence: null, candidateEvidence: null }])) as JobTriageVersion["gateResults"];
const unknown: JobTriageVersion = { triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", opportunityId: "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", targetId: target.targetId, overallVerdict: "unknown", gateResults: gates, pendingItems: [{ gate: "language", reasonCode: "CANDIDATE_EVIDENCE_MISSING", message: "需要补充岗位或画像证据" }], deadlineStatus: "missing", confidenceBasisPoints: 8400, dimensionScores: null, overallScore: null, threshold: null, sequence: 1, createdAt: "2026-09-01T00:00:00.000Z" };

it("以文字和结构展示 unknown/pending，不把它当作通过或显示评分", () => {
  render(<JobTriagePanel opportunityId={unknown.opportunityId} targets={[target]} initialVersion={unknown} />);
  expect(screen.getByText("待补充证据")).toBeInTheDocument();
  expect(screen.getByText("需要补充岗位或画像证据")).toBeInTheDocument();
  expect(screen.queryByText("粗排总分")).toBeNull();
});

it("选择活动求职目标并展示真实目标条件后通过服务端 action 重新评估", async () => {
  const user = userEvent.setup();
  const created = { ...unknown, overallVerdict: "fail" as const, gateResults: { ...unknown.gateResults, location: { verdict: "fail" as const, reasonCode: "LOCATION_CONFLICT", jobEvidence: { sourcePostingVersionId: "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", field: "location", path: "地点", value: "上海" }, candidateEvidence: { kind: "target_constraint" as const, targetId: target.targetId, version: target.version, path: "locations", label: "求职目标条件", value: "北京、上海" } } } };
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
  mocks.createJobTriageAction.mockResolvedValue({ ok: true, triage: created });
  render(<JobTriagePanel opportunityId={unknown.opportunityId} targets={[target]} initialVersion={null} />);
  await user.click(screen.getByRole("button", { name: "开始资格与粗排" }));
  await waitFor(() => expect(screen.getByText("不符合资格门槛")).toBeInTheDocument());
  expect(screen.getByText("求职目标条件：北京、上海")).toBeInTheDocument();
  expect(screen.queryByText("求职目标条件：已设置")).toBeNull();
  expect(mocks.createJobTriageAction).toHaveBeenCalledWith(unknown.opportunityId, target.targetId);
});
