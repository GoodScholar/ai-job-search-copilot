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
  expect(screen.queryByText(/0001/)).not.toBeInTheDocument();
  expect(screen.queryByText("01")).not.toBeInTheDocument();
});

it("links the empty state to the real profile entry", () => {
  render(<WorkbenchHomeView home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("link", { name: "导入 Markdown 职业资料" })).toHaveAttribute("href", "/profile");
});

it("explains that pending facts cannot yet affect recommendations or materials", () => {
  render(<WorkbenchHomeView home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 2, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByText("待确认事实尚未进入求职画像，不能用于推荐或材料生成。")).toBeInTheDocument();
});
