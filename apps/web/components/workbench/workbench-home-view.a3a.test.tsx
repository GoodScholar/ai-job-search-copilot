import type { RecommendationRun, RecommendationRunPreparation } from "@job-copilot/contracts/recommendation-runs";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const refresh = vi.fn();
const agentRunProps = vi.fn<(props: { refreshVersion: number }) => void>();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./agent-inbox-panel", () => ({ AgentInboxPanel: ({ onRunUpdated }: { onRunUpdated?: () => void }) => <button onClick={() => onRunUpdated?.()} type="button">触发运行更新</button>, loadAgentInbox: vi.fn() }));
vi.mock("./agent-run-panel", () => ({ AgentRunPanel: (props: { refreshVersion: number }) => { agentRunProps(props); return <p>旧运行版本 {props.refreshVersion}</p>; } }));
vi.mock("./recommendation-run-panel", async () => {
  const React = await import("react");
  return { RecommendationRunPanel: ({ initialRun }: { initialRun: RecommendationRun | null }) => <button data-instance={React.useId()} type="button">{initialRun?.runId ?? "none"}</button> };
});

import { WorkbenchHomeView } from "./workbench-home-view";

const root = { runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" } as unknown as RecommendationRun;
const preparation = { preflight: { checkedAt: "2026-09-14T08:00:00.000Z" } } as unknown as RecommendationRunPreparation;

afterEach(() => { refresh.mockClear(); agentRunProps.mockClear(); });

it("Inbox onRunUpdated 刷新路由并递增旧物理面板 refreshVersion", () => {
  render(<WorkbenchHomeView home={null} inbox={{ items: [] }} initialRun={null} targets={null} />);
  fireEvent.click(screen.getByRole("button", { name: "触发运行更新" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(agentRunProps).toHaveBeenLastCalledWith(expect.objectContaining({ refreshVersion: 1 }));
});

it("同一 logical root 的新服务端 props 更新投影且不重挂载推荐面板", () => {
  const view = render(<WorkbenchHomeView home={null} inbox={{ items: [] }} initialRecommendationPreparation={preparation} initialRecommendationRun={root} initialRun={null} targets={null} />);
  const panel = screen.getByRole("button", { name: root.runId });
  panel.focus();
  const instance = panel.getAttribute("data-instance");
  view.rerender(<WorkbenchHomeView home={null} inbox={{ items: [] }} initialRecommendationPreparation={{ ...preparation, preflight: { checkedAt: "2026-09-14T09:00:00.000Z" } } as unknown as RecommendationRunPreparation} initialRecommendationRun={{ ...root, updatedAt: "2026-09-14T09:00:00.000Z" } as unknown as RecommendationRun} initialRun={null} targets={null} />);
  expect(screen.getByRole("button", { name: root.runId })).toHaveAttribute("data-instance", instance);
  expect(document.activeElement).toBe(panel);
});
