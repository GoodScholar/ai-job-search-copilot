import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/profile" }));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

import { WorkbenchNavigation } from "./workbench-navigation";

it("sets aria-current only on the current real workbench destination", () => {
  render(<WorkbenchNavigation />);

  expect(screen.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
  expect(screen.queryByRole("link", { name: "推荐" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "投递" })).not.toBeInTheDocument();
});
