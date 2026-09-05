import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReevaluationForm } from "./reevaluate-button";

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
    return (received.length === 1 ? { kind: "warning_confirmation_required" as const, preflight: { warningFingerprint: fingerprint } } : { kind: "started" as const }) as never;
  }} />);

  const first = key();
  await user.click(screen.getByRole("button", { name: "重新评估此岗位" }));
  expect(screen.getByRole("button", { name: "我已了解，仍要重新评估" })).toBeVisible();
  expect(received).toEqual([{ key: first, fingerprint: null }]);
  await user.click(screen.getByRole("button", { name: "我已了解，仍要重新评估" }));
  await waitFor(() => expect(received).toEqual([{ key: first, fingerprint: null }, { key: first, fingerprint }]));
});
