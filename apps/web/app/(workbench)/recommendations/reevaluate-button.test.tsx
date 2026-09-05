import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import { ReevaluationForm } from "./reevaluate-button";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const checkedAt = "2026-09-05T00:00:00.000Z";

function preflight(status: RunPreflightReport["status"], fingerprint = "a".repeat(64)): RunPreflightReport {
  const warning = status === "ready_with_warnings";
  return {
    version: "run-preflight-v1", workflow: "deep_match", trigger: "manual", targetId, status,
    warningFingerprint: warning ? fingerprint : null, checkedAt,
    items: [{
      code: status === "blocked" ? "PROFILE_EVIDENCE_MISSING" : "SOURCE_HEALTH_UNCHECKED",
      severity: status === "blocked" ? "blocking" : "warning",
      summary: status === "blocked" ? "请先完善求职画像" : "来源状态需要确认",
      evidence: status === "blocked"
        ? { kind: "profile", activeTrustedFactCount: 0, latestFactRevisionId: null, checkedAt }
        : { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null },
      impact: status === "blocked" ? "尚不能安全重新评估" : "本次结果可能遗漏新变化",
      retryable: status !== "blocked",
      suggestedActions: status === "blocked" ? ["review_profile"] : ["review_source_health"],
    }],
  };
}

function key(): string {
  return (screen.getByRole("button", { name: "重新评估此岗位" }).closest("form")!.elements.namedItem("idempotencyKey") as HTMLInputElement).value;
}

it("在成功提交后轮换重评幂等键，使下一次用户意图创建新运行", async () => {
  const user = userEvent.setup();
  const received: string[] = [];
  render(<ReevaluationForm action={(formData) => { received.push(String(formData.get("idempotencyKey"))); return { kind: "started" }; }} />);

  const first = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  await waitFor(() => expect(received).toEqual([first]));
  await waitFor(() => expect(key()).not.toBe(first));
  const second = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  await waitFor(() => expect(received).toEqual([first, second]));
});

it("提交失败时保留同一个幂等键，以便安全重放", async () => {
  const user = userEvent.setup();
  const action = vi.fn(async () => { throw new Error("RETRYABLE_FAILURE"); });
  render(<ReevaluationForm action={action} />);

  const before = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("重新评估未启动"));
  expect(key()).toBe(before);
});

it("警告结果需要第二次明确确认，并把最新 fingerprint 放入隐藏字段", async () => {
  const user = userEvent.setup();
  const fingerprint = "a".repeat(64);
  const received: Array<{ key: string; fingerprint: string | null }> = [];
  render(<ReevaluationForm action={(formData) => {
    received.push({ key: String(formData.get("idempotencyKey")), fingerprint: String(formData.get("warningFingerprint") || "") || null });
    return received.length === 1 ? { kind: "warning_confirmation_required" as const, preflight: preflight("ready_with_warnings", fingerprint) } : { kind: "started" as const };
  }} />);

  const first = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  expect(screen.getByRole("button", { name: "我已了解，仍要重新评估" })).toBeVisible();
  expect(received).toEqual([{ key: first, fingerprint: null }]);
  await user.click(screen.getByRole("button", { name: "我已了解，仍要重新评估" }));
  await waitFor(() => expect(received).toEqual([{ key: first, fingerprint: null }, { key: first, fingerprint }]));
});

it("阻塞结果展示完整安全检查和修复链接，且没有任何继续提交按钮", async () => {
  const user = userEvent.setup();
  render(<ReevaluationForm action={() => ({ kind: "blocked", preflight: preflight("blocked") })} />);

  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));

  expect(screen.getByText("请先完善求职画像")).toBeVisible();
  expect(screen.getByText("影响：尚不能安全重新评估")).toBeVisible();
  expect(screen.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("过期确认用最新报告和 fingerprint 替换卡片，但保留同一个幂等键", async () => {
  const user = userEvent.setup();
  const firstFingerprint = "a".repeat(64);
  const currentFingerprint = "b".repeat(64);
  const received: Array<{ key: string; fingerprint: string | null }> = [];
  render(<ReevaluationForm action={(formData) => {
    received.push({ key: String(formData.get("idempotencyKey")), fingerprint: String(formData.get("warningFingerprint") || "") || null });
    if (received.length === 1) return { kind: "warning_confirmation_required" as const, preflight: preflight("ready_with_warnings", firstFingerprint) };
    if (received.length === 2) return { kind: "warning_confirmation_required" as const, preflight: { ...preflight("ready_with_warnings", currentFingerprint), items: [{ ...preflight("ready_with_warnings", currentFingerprint).items[0]!, impact: "新的影响，需要再次确认" }] } };
    return { kind: "started" as const };
  }} />);

  const stableKey = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  await user.click(screen.getByRole("button", { name: "我已了解，仍要重新评估" }));

  expect(screen.getByText("影响：新的影响，需要再次确认")).toBeVisible();
  expect(screen.getByRole("button", { name: "我已了解，仍要重新评估" })).toBeVisible();
  expect(screen.getByRole("button", { name: "我已了解，仍要重新评估" })).toBeEnabled();
  expect((screen.getByRole("button", { name: "我已了解，仍要重新评估" }).closest("form")!.elements.namedItem("warningFingerprint") as HTMLInputElement).value).toBe(currentFingerprint);
  expect((screen.getByRole("button", { name: "我已了解，仍要重新评估" }).closest("form")!.elements.namedItem("idempotencyKey") as HTMLInputElement).value).toBe(stableKey);
  expect(received).toEqual([{ key: stableKey, fingerprint: null }, { key: stableKey, fingerprint: firstFingerprint }]);
});
