import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));

import { JobOpportunitiesView } from "./job-opportunities-view";

const first = { opportunityId: "00000000-0000-4000-8000-000000000001", company: "示例科技", title: "前端工程师", location: "上海", archivedAt: null, version: 0 };
const second = { opportunityId: "00000000-0000-4000-8000-000000000002", company: "示例科技", title: "全栈工程师", location: "杭州", archivedAt: null, version: 0 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const initialPage = { items: [first], nextCursor: "00000000-0000-4000-8000-000000000099", counts: { active: 2, archived: 0 } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.replace.mockReset(); });

it("同步归档筛选到 URL，并可加载下一页和恢复已归档岗位", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ items: [second], nextCursor: null, counts: { active: 2, archived: 0 } }))
    .mockResolvedValueOnce(response({ items: [{ ...first, archivedAt: "2026-09-15T08:00:00.000Z", version: 1 }], nextCursor: null, counts: { active: 1, archived: 1 } }))
    .mockResolvedValueOnce(response({ applied: true, state: { archivedAt: null, version: 2 } }))
    .mockResolvedValueOnce(response({ items: [first], nextCursor: null, counts: { active: 2, archived: 0 } }));
  vi.stubGlobal("fetch", fetcher);
  render(<JobOpportunitiesView initialFilter="active" initialPage={initialPage} />);

  expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  fireEvent.click(screen.getByRole("button", { name: "加载更多岗位" }));
  expect(await screen.findByText("全栈工程师")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "已归档 0" }));
  expect(await screen.findByRole("button", { name: "恢复岗位：前端工程师" })).toBeVisible();
  expect(mocks.replace).toHaveBeenCalledWith("/jobs?filter=archived", { scroll: false });
  fireEvent.click(screen.getByRole("button", { name: "恢复岗位：前端工程师" }));
  await screen.findByText("已恢复到活跃岗位。");
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/archive-state"), expect.objectContaining({ method: "POST" }));
});

it("筛选读取失败时保留当前筛选和可执行动作", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, 502)));
  render(<JobOpportunitiesView initialFilter="active" initialPage={{ ...initialPage, nextCursor: null }} />);

  fireEvent.click(screen.getByRole("button", { name: "已归档 0" }));
  await screen.findByText("岗位列表暂时无法读取，请重试。");
  expect(screen.getByRole("button", { name: "活跃 2" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "归档岗位：前端工程师" })).toBeEnabled();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it("网络失败重试会重放同一 commandId", async () => {
  const fetcher = vi.fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(response({ applied: true, state: { archivedAt: "2026-09-15T08:00:00.000Z", version: 1 } }))
    .mockResolvedValueOnce(response({ items: [], nextCursor: null, counts: { active: 1, archived: 1 } }));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000123");
  render(<JobOpportunitiesView initialFilter="active" initialPage={{ ...initialPage, nextCursor: null }} />);

  fireEvent.click(screen.getByRole("button", { name: "归档岗位：前端工程师" }));
  expect(await screen.findByRole("button", { name: "重试归档岗位" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重试归档岗位" }));
  await screen.findByText("已归档，可在归档岗位中恢复。");
  const firstBody = JSON.parse(fetcher.mock.calls[0]![1].body as string);
  const retryBody = JSON.parse(fetcher.mock.calls[1]![1].body as string);
  expect(retryBody.commandId).toBe(firstBody.commandId);
});

it("版本冲突刷新列表后允许重新操作", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(null, 409))
    .mockResolvedValueOnce(response({ items: [{ ...first, version: 1 }], nextCursor: null, counts: { active: 1, archived: 0 } }));
  vi.stubGlobal("fetch", fetcher);
  render(<JobOpportunitiesView initialFilter="active" initialPage={{ ...initialPage, nextCursor: null }} />);
  fireEvent.click(screen.getByRole("button", { name: "归档岗位：前端工程师" }));
  await screen.findByText("岗位状态已更新，已刷新列表，请重试。");
  await waitFor(() => expect(screen.getByRole("button", { name: "归档岗位：前端工程师" })).toBeEnabled());
});

it("归档页尾岗位后重载当前筛选以重建游标和计数", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ applied: true, state: { archivedAt: "2026-09-15T08:00:00.000Z", version: 1 } }))
    .mockResolvedValueOnce(response({ items: [second], nextCursor: null, counts: { active: 1, archived: 1 } }));
  vi.stubGlobal("fetch", fetcher);
  render(<JobOpportunitiesView initialFilter="active" initialPage={initialPage} />);

  fireEvent.click(screen.getByRole("button", { name: "归档岗位：前端工程师" }));
  await screen.findByText("全栈工程师");
  expect(fetcher.mock.calls[1]![0]).toBe("/api/job-opportunities?filter=active");
  expect(screen.queryByRole("button", { name: "加载更多岗位" })).not.toBeInTheDocument();
});
