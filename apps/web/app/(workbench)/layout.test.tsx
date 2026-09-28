import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@/components/workbench/workbench-header", () => ({ WorkbenchHeader: () => <p>工作台内容</p> }));

import WorkbenchLayout from "./layout";

it("以准确的求职工作台名称标识侧栏 landmark", () => {
  render(<WorkbenchLayout><p>页面内容</p></WorkbenchLayout>);

  expect(screen.getByRole("complementary", { name: "求职工作台" })).toBeVisible();
  expect(screen.getByRole("complementary")).not.toHaveAccessibleName(/职业透镜/u);
});
