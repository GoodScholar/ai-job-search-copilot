import { render, screen } from "@testing-library/react";
import { WorkbenchHomeView } from "./workbench-home-view";

const emptyTargets = { suggestions: [], targets: [] };

it("shows only persisted empty workbench data", () => {
  render(<WorkbenchHomeView inbox={{ items: [] }} initialRun={null} targets={emptyTargets} home={{
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
  render(<WorkbenchHomeView inbox={{ items: [] }} initialRun={null} targets={emptyTargets} home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByText("上传一份 Markdown 或 DOCX 职业资料，系统会从原文中提取带证据的候选事实。")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "导入职业资料" })).toHaveAttribute("href", "/profile");
});

it("explains that pending facts cannot yet affect recommendations or materials", () => {
  render(<WorkbenchHomeView inbox={{ items: [] }} initialRun={null} targets={emptyTargets} home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 2, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("heading", { name: "职业资料等待确认" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看待确认事实" })).toHaveAttribute("href", "/profile");
  expect(screen.getByText("待确认事实尚未进入求职画像，不能用于推荐或材料生成。")).toBeInTheDocument();
  expect(screen.queryByText("职业资料尚未建立")).not.toBeInTheDocument();
  expect(screen.queryByText("当前账号还没有可供推荐、核对或投递的职业资料。所有计数均来自你的当前记录。")).not.toBeInTheDocument();
});

it("adds a visible job-import entry without enabling the recommendation surface", () => {
  render(<WorkbenchHomeView inbox={{ items: [] }} initialRun={null} targets={emptyTargets} home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("link", { name: "导入岗位" })).toHaveAttribute("href", "/jobs/import");
  expect(screen.queryByRole("link", { name: "查看推荐" })).not.toBeInTheDocument();
});

it("directs users without an active target to confirm one while preserving profile and job import entries", () => {
  render(<WorkbenchHomeView inbox={{ items: [] }} initialRun={null} targets={emptyTargets} home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("heading", { name: "先确认求职目标" })).toBeVisible();
  expect(screen.getByRole("link", { name: "确认求职目标" })).toHaveAttribute("href", "/profile/targets");
  expect(screen.getByRole("link", { name: "导入职业资料" })).toHaveAttribute("href", "/profile");
  expect(screen.getByRole("link", { name: "导入岗位" })).toHaveAttribute("href", "/jobs/import");
});
