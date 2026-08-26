import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefingStack } from "./briefing-stack";

it("lets the user bring a briefing to the front", async () => {
  const user = userEvent.setup();
  render(<BriefingStack />);

  expect(screen.getByText("AI 应用工程师").closest("article")).toHaveAttribute(
    "data-active",
    "true",
  );

  await user.click(
    screen.getByRole("button", { name: "查看确认 2 条候选事实" }),
  );

  expect(
    screen.getByText("确认 2 条候选事实").closest("article"),
  ).toHaveAttribute("data-active", "true");
});
