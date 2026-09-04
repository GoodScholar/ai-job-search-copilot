import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";
import { RecommendationHistory } from "./recommendation-history";

const targetId = "00000000-0000-4000-8000-000000000001";
const list = (id: string, sequence: number) => ({ recommendationListId: id, targetId, localDate: "2026-09-02", sequence, createdAt: "2026-09-02T00:00:00.000Z", exclusions: [], items: [] });
const initialPage = { items: [list("00000000-0000-4000-8000-000000000010", 1), list("00000000-0000-4000-8000-000000000011", 2)], nextCursor: null } satisfies RecommendationListHistoryPage;

it("按清单显示 pending/error，成功重试清错且不同清单可以并行加载", async () => {
  const user = userEvent.setup();
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => first)
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<RecommendationHistory targetId={targetId} initialPage={initialPage} />);
  await user.click(screen.getByText("历史版本"));
  await user.click(screen.getByText(/清单版本 1/u));
  await user.click(screen.getByText(/清单版本 2/u));
  const buttons = screen.getAllByRole("button", { name: "查看稳定排除" });
  await user.click(buttons[0]!);
  await user.click(buttons[1]!);
  expect(screen.getByRole("button", { name: "加载中" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  rejectFirst(new Error("offline"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("稳定排除加载失败"));
  await user.click(screen.getAllByRole("button", { name: "查看稳定排除" })[0]!);
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
