import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CalibrationProposals } from "./calibration-proposals";

const proposal = { proposalId: "00000000-0000-4000-8000-000000000001", targetId: "00000000-0000-4000-8000-000000000002", reason: "LOCATION" as const, status: "pending" as const, version: 1, evidenceCount: 3, revision: { revisionId: "00000000-0000-4000-8000-000000000003", revisionNumber: 1, strategy: "raise_quality_bar" as const, ruleConfig: { minimumOverallScore: 75, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: [] }, impactPreview: { sampleSize: 3, estimatedAffectedCount: 2, ruleDiff: { minimumOverallScore: { from: 60, to: 75 } } } } };

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

it("将 Server Action 失败映射为屏幕阅读器可读错误", async () => {
  render(<CalibrationProposals proposals={[proposal]} reviseAction={vi.fn().mockResolvedValue(undefined)} resolveAction={vi.fn().mockRejectedValue(new Error("conflict"))} />);
  fireEvent.click(screen.getByRole("button", { name: "拒绝建议" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("操作未完成，请刷新后重试。"));
});
