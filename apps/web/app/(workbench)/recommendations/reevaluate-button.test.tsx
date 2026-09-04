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
  render(<ReevaluationForm action={(formData) => { received.push(String(formData.get("idempotencyKey"))); }} />);

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
