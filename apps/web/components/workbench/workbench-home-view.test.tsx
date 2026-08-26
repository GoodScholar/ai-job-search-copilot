import { render, screen } from "@testing-library/react";
import { WorkbenchHomeView } from "./workbench-home-view";

it("shows only persisted empty workbench data", () => {
  render(<WorkbenchHomeView home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("heading", { name: "从真实职业资料开始" })).toBeInTheDocument();
  expect(screen.getByText("今日推荐").nextSibling).toHaveTextContent("0");
  expect(screen.queryByText("AI 应用工程师（示例）")).not.toBeInTheDocument();
});

it("keeps the next step honest until the profile entry is available", () => {
  render(<WorkbenchHomeView home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByText("职业资料入口将在后续切片开放")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /职业资料/ })).not.toBeInTheDocument();
});
