import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoginPage from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("shows the honest local development boundary by default", async () => {
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "");

  render(await LoginPage({ searchParams: Promise.resolve({ returnTo: "/profile" }) }));

  expect(screen.getByText("本地开发登录")).toBeInTheDocument();
  expect(screen.getByText("正式邀请制 Beta 将使用微信登录")).toBeInTheDocument();
  expect(
    screen.getByText("本实施批次只建立登录边界，尚未创建用户会话"),
  ).toBeInTheDocument();
  expect(screen.getByText("/profile")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("shows only the pending WeChat adapter and rejects external return paths", async () => {
  vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "wechat");

  render(
    await LoginPage({
      searchParams: Promise.resolve({ returnTo: "https://example.com" }),
    }),
  );

  expect(screen.getByText("微信 OAuth Adapter 待服务端接入")).toBeInTheDocument();
  expect(screen.getByText("/")).toBeInTheDocument();
  expect(screen.queryByText("本地开发登录")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
