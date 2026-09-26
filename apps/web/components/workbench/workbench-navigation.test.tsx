import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/profile" }));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

import { WorkbenchNavigation } from "./workbench-navigation";

it("renders the fixed 首页、推荐、投递、画像 order and only links real destinations", () => {
  render(<WorkbenchNavigation />);

  expect(screen.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("link", { name: "推荐" })).toHaveAttribute("href", "/recommendations");
  expect(screen.queryByRole("link", { name: "投递" })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "求职工作台导航" }).textContent).toBe("首页推荐投递画像");
  expect(screen.getByRole("link", { name: "推荐" })).not.toHaveAttribute("aria-disabled");
  expect(screen.getByText("投递")).toHaveAttribute("aria-disabled", "true");
});

it("keeps 画像和目标与来源 for its nested Watchlist destination", () => {
  mocks.pathname = "/profile/targets/target-123/watchlist";
  render(<WorkbenchNavigation />);

  expect(screen.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "目标与来源" })).toHaveAttribute("aria-current", "page");
});

it("在任何画像路由中提供不依赖已有事实的上下文入口", () => {
  mocks.pathname = "/profile";
  render(<WorkbenchNavigation />);

  const context = screen.getByRole("navigation", { name: "画像上下文" });
  expect(within(context).getByRole("link", { name: "职业资料" })).toHaveAttribute("href", "/profile");
  expect(within(context).getByRole("link", { name: "目标与来源" })).toHaveAttribute("href", "/profile/targets");
  expect(within(context).getByRole("link", { name: "运行策略" })).toHaveAttribute("href", "/profile/run-policy");
  expect(within(context).getByRole("link", { name: "模型连接" })).toHaveAttribute("href", "/profile/model-connection");
});
