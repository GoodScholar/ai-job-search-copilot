import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getModelDiagnostics: vi.fn(), view: vi.fn(() => <div>模型连接视图</div>) }));
vi.mock("@/lib/server/model-diagnostics", () => ({ getModelDiagnostics: mocks.getModelDiagnostics }));
vi.mock("@/components/workbench/model-connection-view", () => ({ ModelConnectionView: mocks.view }));

import ModelConnectionPage, { metadata } from "./page";

it("服务端读取初始模型连接状态并传给交互视图", async () => {
  const diagnostics = { status: "unverified" };
  mocks.getModelDiagnostics.mockResolvedValue(diagnostics);
  render(await ModelConnectionPage());
  expect(mocks.view).toHaveBeenCalledWith({ initialDiagnostics: diagnostics }, undefined);
  expect(screen.getByText("模型连接视图")).toBeInTheDocument();
  expect(metadata.title).toBe("模型连接 | AI Job Search Copilot");
});
