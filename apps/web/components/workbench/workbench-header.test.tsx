import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("@/app/login/actions", () => ({ endSessionAction: vi.fn() }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
}));

import { WorkbenchHeader } from "./workbench-header";

it("marks only real workbench controls as 44px touch targets", () => {
  render(<WorkbenchHeader />);

  expect(screen.getByRole("link", { name: "AI Job Search Copilot" })).toHaveClass("workbench-touch-target");
  expect(screen.getByRole("link", { name: "首页" })).toHaveClass("workbench-touch-target");
  expect(screen.getByRole("button", { name: "退出" })).toHaveClass("workbench-touch-target");
  expect(screen.queryByRole("link", { name: "推荐" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "投递" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "画像" })).not.toBeInTheDocument();
});
