import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CalibrationProposals } from "./calibration-proposals";

const proposal = { proposalId: "00000000-0000-4000-8000-000000000001", targetId: "00000000-0000-4000-8000-000000000002", reason: "LOCATION" as const, status: "pending" as const, version: 1, evidenceCount: 3, availableStrategies: ["require_related_evidence", "exclude_evidence_opportunities"] as Array<"require_related_evidence" | "exclude_evidence_opportunities" | "raise_quality_bar">, revision: { revisionId: "00000000-0000-4000-8000-000000000003", revisionNumber: 1, strategy: "raise_quality_bar" as const, ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: [] }, impactPreview: { sampleSize: 3, estimatedAffectedCount: 2, ruleDiff: { minimumOverallScore: { from: 60, to: 75 } } } } };

it("展示校准证据、规则差异、影响预览与可访问的成功状态", async () => {
  const revise = vi.fn().mockResolvedValue(undefined); const resolve = vi.fn().mockResolvedValue(undefined);
  render(<CalibrationProposals proposals={[proposal]} reviseAction={revise} resolveAction={resolve} />);
  expect(screen.getByText("因“地点或工作方式不合适”产生的建议")).toBeInTheDocument();
  expect(screen.getByText(/预计会影响 2 \/ 3 个样本/u)).toBeInTheDocument(); expect(screen.getByText(/最低匹配分：60 → 75/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("校准建议已修改。"));
  expect(revise).toHaveBeenCalledOnce();
});

it("失败重渲染仍复用同一幂等键，且不展示内部原因码或 UUID", async () => {
  const revise = vi.fn().mockRejectedValue(new Error("temporary"));
  render(<CalibrationProposals proposals={[proposal]} reviseAction={revise} resolveAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(revise).toHaveBeenCalledTimes(2));
  const first = revise.mock.calls[0]![1] as FormData; const second = revise.mock.calls[1]![1] as FormData;
  expect(first.get("idempotencyKey")).toBe(second.get("idempotencyKey"));
  expect(screen.queryByText("LOCATION")).not.toBeInTheDocument();
  expect(screen.queryByText(proposal.proposalId)).not.toBeInTheDocument();
});

it("建议从空列表出现时生成 UUID，同一版本重试复用、版本推进后更换", async () => {
  const revise = vi.fn().mockRejectedValue(new Error("temporary")); const resolve = vi.fn();
  const view = render(<CalibrationProposals proposals={[]} reviseAction={revise} resolveAction={resolve} />);
  view.rerender(<CalibrationProposals proposals={[proposal]} reviseAction={revise} resolveAction={resolve} />);
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(revise).toHaveBeenCalledOnce());
  const first = revise.mock.calls[0]![1] as FormData;
  expect(first.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/u);
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(revise).toHaveBeenCalledTimes(2));
  expect((revise.mock.calls[1]![1] as FormData).get("idempotencyKey")).toBe(first.get("idempotencyKey"));
  view.rerender(<CalibrationProposals proposals={[{ ...proposal, version: 2, revision: { ...proposal.revision, revisionNumber: 2 } }]} reviseAction={revise} resolveAction={resolve} />);
  fireEvent.click(screen.getByRole("button", { name: "修改建议" }));
  await waitFor(() => expect(revise).toHaveBeenCalledTimes(3));
  expect((revise.mock.calls[2]![1] as FormData).get("idempotencyKey")).not.toBe(first.get("idempotencyKey"));
});

it("九类原因只渲染服务端给出的可执行策略，空集合禁用提交", () => {
  const reasons = ["ROLE_DIRECTION", "LOCATION", "SALARY", "COMPANY", "INDUSTRY", "SENIORITY", "MISMATCH", "EXPIRED", "ALREADY_HANDLED"] as const;
  const options = [["raise_quality_bar"], ["exclude_evidence_opportunities"], ["require_related_evidence", "exclude_evidence_opportunities"]] as const;
  const { container } = render(<CalibrationProposals proposals={reasons.map((reason, index) => ({ ...proposal, proposalId: `00000000-0000-4000-8000-0000000000${index + 10}`, reason, availableStrategies: [...options[index % options.length]!], revision: { ...proposal.revision, strategy: reason === "EXPIRED" || reason === "ALREADY_HANDLED" ? "raise_quality_bar" : "require_related_evidence" } }))} reviseAction={vi.fn()} resolveAction={vi.fn()} />);
  const selects = within(container).getAllByRole("combobox", { name: "修改策略" });
  expect(selects).toHaveLength(9);
  for (const [index, select] of selects.entries()) expect(within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(options[index % options.length]);
  expect(screen.getAllByRole("button", { name: "修改建议" }).filter((button) => (button as HTMLButtonElement).disabled)).toHaveLength(0);
  const exhausted = { ...proposal, reason: "EXPIRED" as const, availableStrategies: [], revision: { ...proposal.revision, strategy: "raise_quality_bar" as const, ruleConfig: { ...proposal.revision.ruleConfig, minimumOverallScore: 91, excludedOpportunityIds: ["00000000-0000-4000-8000-000000000099"] } } };
  render(<CalibrationProposals proposals={[exhausted]} reviseAction={vi.fn()} resolveAction={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: "修改建议" }).at(-1)).toBeDisabled();
});

it("将 Server Action 失败映射为屏幕阅读器可读错误", async () => {
  render(<CalibrationProposals proposals={[proposal]} reviseAction={vi.fn().mockResolvedValue(undefined)} resolveAction={vi.fn().mockRejectedValue(new Error("conflict"))} />);
  fireEvent.click(screen.getByRole("button", { name: "拒绝建议" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("操作未完成，请刷新后重试。"));
});
