import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { RecommendationList } from "@job-copilot/contracts/recommendations";
import { LatestExclusions } from "./latest-exclusions";

const targetId = "00000000-0000-4000-8000-000000000001";
const listId = "00000000-0000-4000-8000-000000000002";
const exclusions = Array.from({ length: 25 }, (_, index) => ({ opportunityId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const }));
const list = { recommendationListId: listId, targetId, localDate: "2026-09-02", sequence: 1, createdAt: "2026-09-02T00:00:00.000Z", exclusions, exclusionsNextCursor: "00000000-0000-4000-8000-000000000099", items: [] } satisfies RecommendationList;

it("按 cursor 合并下一页 latest exclusions 并移除已耗尽的加载控件", async () => {
  const user = userEvent.setup();
  const next = { opportunityId: "10000000-0000-4000-8000-000000000026", reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [next], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<LatestExclusions targetId={targetId} list={list} />);

  await user.click(screen.getByRole("button", { name: "加载更多稳定排除" }));
  await waitFor(() => expect(screen.getByText(/稳定排除 26 项岗位/u)).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "加载更多稳定排除" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cursor=00000000-0000-4000-8000-000000000099"), { cache: "no-store" });
});
