import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FirstRecommendationJourneyPanel } from "./first-recommendation-journey";

const steps = [
  ["career_materials", "准备可用职业资料", "needs_action", "需要处理", "导入职业资料", "/profile"],
  ["profile_evidence", "建立可信求职画像", "completed", "已完成", "完善求职画像", "/profile"],
  ["primary_target", "明确主要求职方向", "waiting", "等待开始", "查看求职目标", "/profile/targets"],
  ["job_sources", "接通真实岗位来源", "waiting", "等待开始", "配置岗位来源", "/profile/targets/target-1/watchlist"],
  ["run_readiness", "确认今天可以开始", "waiting", "等待开始", "检查模型连接", "/profile/model-connection"],
  ["first_result", "获得第一份推荐结果", "waiting", "等待开始", "开始推荐", "/home"],
] as const;

const activeJourney = (interactionVersion = 7) => ({
  status: "active" as const,
  interactionVersion,
  currentStepId: "career_materials" as const,
  completedAt: null,
  steps: steps.map(([id, title, status, stateLabel, label, href]) => ({ id, title, status, stateLabel, impact: `完成${title}后，才能继续获得可信推荐。`, action: { label, href } })),
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("以语义化步骤显示六个结果导向标题、状态、影响与站内入口", () => {
  render(<FirstRecommendationJourneyPanel journey={activeJourney()} onAuthoritativeRefresh={vi.fn()} />);

  const region = screen.getByRole("region", { name: "首次推荐旅程" });
  expect(region.querySelector("ol")).toBeTruthy();
  for (const [, title, , stateLabel, label, href] of steps) {
    expect(screen.getByRole("heading", { name: title })).toBeVisible();
    expect(screen.getAllByText(stateLabel).length).toBeGreaterThan(0);
    expect(screen.getByText(`完成${title}后，才能继续获得可信推荐。`)).toBeVisible();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
  }
  expect(screen.getByRole("heading", { name: "准备可用职业资料" }).closest("li")).toHaveAttribute("aria-current", "step");
});

it("步骤入口用权威版本后台保存访问，但保留链接导航", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<FirstRecommendationJourneyPanel journey={activeJourney(11)} onAuthoritativeRefresh={refresh} />);

  const link = screen.getByRole("link", { name: "导入职业资料" });
  let defaultWasPrevented: boolean | null = null;
  const preserveNavigation = (event: MouseEvent) => {
    defaultWasPrevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", preserveNavigation);
  await user.click(link);
  document.removeEventListener("click", preserveNavigation);
  expect(defaultWasPrevented).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith("/api/workbench/first-recommendation-journey", expect.objectContaining({
    method: "PUT", keepalive: true, body: JSON.stringify({ action: "visit_step", stepId: "career_materials", expectedVersion: 11 }),
  }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it.each([
  ["网络失败", () => Promise.reject(new TypeError("offline"))],
  ["非 2xx 响应", () => Promise.resolve(new Response(null, { status: 500 }))],
])("步骤入口在%s时仍保留真实链接默认导航", async (_scenario, response) => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(response);
  vi.stubGlobal("fetch", fetchMock);
  render(<FirstRecommendationJourneyPanel journey={activeJourney(12)} onAuthoritativeRefresh={refresh} />);

  const link = screen.getByRole("link", { name: "导入职业资料" });
  let defaultWasPrevented: boolean | null = null;
  const preserveNavigation = (event: MouseEvent) => {
    defaultWasPrevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", preserveNavigation);
  await user.click(link);
  document.removeEventListener("click", preserveNavigation);

  expect(link).toHaveAttribute("href", "/profile");
  expect(defaultWasPrevented).toBe(false);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(refresh).not.toHaveBeenCalled();
});

it("关闭成功后才隐藏并播报，409 刷新权威投影", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
  const { rerender } = render(<FirstRecommendationJourneyPanel journey={activeJourney(5)} onAuthoritativeRefresh={refresh} />);

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "首次推荐旅程" })).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("已暂时关闭首次推荐旅程。");
  expect(refresh).toHaveBeenCalledOnce();

  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 })));
  rerender(<FirstRecommendationJourneyPanel journey={activeJourney(6)} onAuthoritativeRefresh={refresh} />);
  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("region", { name: "首次推荐旅程" })).toBeVisible();
});

it("关闭网络失败后保留旅程并可重试，第二次成功才隐藏和播报", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn();
  const fetchMock = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<FirstRecommendationJourneyPanel journey={activeJourney(3)} onAuthoritativeRefresh={refresh} />);

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  expect(screen.getByRole("alert")).toHaveTextContent("暂时无法关闭引导，请重试。");
  expect(screen.getByRole("region", { name: "首次推荐旅程" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "首次推荐旅程" })).not.toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("已暂时关闭首次推荐旅程。");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
});

it("同一版本的新权威投影清除旧关闭错误", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
  const view = render(<FirstRecommendationJourneyPanel journey={activeJourney(3)} onAuthoritativeRefresh={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  expect(screen.getByRole("alert")).toBeVisible();
  const refreshedJourney = {
    ...activeJourney(3),
    currentStepId: "profile_evidence" as const,
    steps: activeJourney(3).steps.map((step) => step.id === "career_materials" ? { ...step, impact: "这是新的权威影响说明。" } : step),
  };
  view.rerender(<FirstRecommendationJourneyPanel journey={refreshedJourney} onAuthoritativeRefresh={vi.fn()} />);

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "建立可信求职画像" }).closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.getByText("这是新的权威影响说明。")).toBeVisible();
});

it("旧关闭成功完成后不会隐藏新的同版本投影", async () => {
  const user = userEvent.setup();
  let resolveRequest: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })));
  const view = render(<FirstRecommendationJourneyPanel journey={activeJourney(3)} onAuthoritativeRefresh={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  view.rerender(<FirstRecommendationJourneyPanel journey={{ ...activeJourney(3), currentStepId: "profile_evidence" }} onAuthoritativeRefresh={vi.fn()} />);
  resolveRequest(new Response(null, { status: 204 }));

  await waitFor(() => expect(screen.getByRole("region", { name: "首次推荐旅程" })).toBeVisible());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("旧关闭失败完成后不会向新的同版本投影报告错误", async () => {
  const user = userEvent.setup();
  let resolveRequest: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })));
  const view = render(<FirstRecommendationJourneyPanel journey={activeJourney(3)} onAuthoritativeRefresh={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "暂时关闭引导" }));
  view.rerender(<FirstRecommendationJourneyPanel journey={{ ...activeJourney(3), currentStepId: "profile_evidence" }} onAuthoritativeRefresh={vi.fn()} />);
  resolveRequest(new Response(null, { status: 500 }));

  await waitFor(() => expect(screen.getByRole("region", { name: "首次推荐旅程" })).toBeVisible());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("仅在旅程局部不可用时显示局部错误，关闭或完成投影不渲染", () => {
  const { rerender } = render(<FirstRecommendationJourneyPanel journey={null} onAuthoritativeRefresh={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "首次推荐旅程暂时无法读取" })).toBeVisible();
  rerender(<FirstRecommendationJourneyPanel journey={{ ...activeJourney(), status: "dismissed" }} onAuthoritativeRefresh={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "首次推荐旅程" })).not.toBeInTheDocument();
  rerender(<FirstRecommendationJourneyPanel journey={{ status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" }} onAuthoritativeRefresh={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "首次推荐旅程" })).not.toBeInTheDocument();
});
