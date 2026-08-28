import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/profile" }));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

import { WorkbenchNavigation } from "./workbench-navigation";

it("renders the fixed 首页、推荐、投递、画像 order and only links real destinations", () => {
  render(<WorkbenchNavigation />);

  expect(screen.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
  expect(screen.queryByRole("link", { name: "推荐" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "投递" })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation").textContent).toBe("首页推荐投递画像");
  expect(screen.getByText("推荐")).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("投递")).toHaveAttribute("aria-disabled", "true");
});

it("keeps 画像 active for its nested 求职目标 destination", () => {
  mocks.pathname = "/profile/targets";
  render(<WorkbenchNavigation />);

  expect(screen.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
});
