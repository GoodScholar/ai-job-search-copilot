import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefingStack } from "./briefing-stack";

it("uses tabs to bring a briefing forward without exposing inactive details", async () => {
  const user = userEvent.setup();
  render(<BriefingStack />);

  const recommendation = screen.getByRole("tab", { name: "AI 应用工程师（示例）" });
  const facts = screen.getByRole("tab", { name: "确认 2 条候选事实（示例）" });

  expect(screen.getByRole("tablist", { name: "切换行动简报" })).toBeInTheDocument();
  expect(recommendation).toHaveAttribute("aria-selected", "true");
  expect(recommendation).toHaveAttribute("aria-controls", "briefing-panel-recommendation");
  expect(screen.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "briefing-tab-recommendation",
  );
  expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(3);

  await user.click(facts);

  expect(facts).toHaveAttribute("aria-selected", "true");
  expect(recommendation).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("项目包含大模型评测相关经验");
});

it("shows each paper title once by using details only for the active paper", async () => {
  const user = userEvent.setup();
  render(<BriefingStack />);

  const cards = screen.getByRole("tablist", { name: "切换行动简报" });

  expect(within(cards).getAllByText("AI 应用工程师", { exact: true })).toHaveLength(1);
  expect(within(cards).getAllByText("确认 2 条候选事实", { exact: true })).toHaveLength(1);
  expect(within(cards).getAllByText("审核 1 份定制简历", { exact: true })).toHaveLength(1);

  await user.click(screen.getByRole("tab", { name: "确认 2 条候选事实（示例）" }));

  expect(within(cards).getAllByText("AI 应用工程师", { exact: true })).toHaveLength(1);
  expect(within(cards).getAllByText("确认 2 条候选事实", { exact: true })).toHaveLength(1);
  expect(within(cards).getAllByText("审核 1 份定制简历", { exact: true })).toHaveLength(1);
});
