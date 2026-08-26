import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startDevSession: vi.fn(),
  endCurrentSession: vi.fn(),
  readSessionToken: vi.fn(),
  writeSessionCookie: vi.fn(),
  deleteSessionCookie: vi.fn(),
  redirect: vi.fn((location: string) => {
    throw new Error(`redirect:${location}`);
  }),
}));

const {
  startDevSession,
  endCurrentSession,
  readSessionToken,
  writeSessionCookie,
  deleteSessionCookie,
  redirect,
} = mocks;

vi.mock("@/lib/server/api-client", () => ({
  api: { startDevSession: mocks.startDevSession, endCurrentSession: mocks.endCurrentSession },
}));
vi.mock("@/lib/server/session-cookie", () => ({
  readSessionToken: mocks.readSessionToken,
  writeSessionCookie: mocks.writeSessionCookie,
  deleteSessionCookie: mocks.deleteSessionCookie,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { endSessionAction, startDevSessionAction } from "./actions";

afterEach(() => {
  vi.clearAllMocks();
});

it("starts a local session, stores its opaque cookie, and redirects untrusted return paths home", async () => {
  startDevSession.mockResolvedValue({
    sessionToken: "a".repeat(43),
    expiresAt: "2026-09-02T08:00:00.000Z",
  });
  const formData = new FormData();
  formData.set("returnTo", "https://evil.example");

  await expect(startDevSessionAction(formData)).rejects.toThrow("redirect:/home");

  expect(writeSessionCookie).toHaveBeenCalledWith(
    "a".repeat(43),
    new Date("2026-09-02T08:00:00.000Z"),
  );
  expect(redirect).toHaveBeenCalledWith("/home");
});

it("only clears the cookie after the API confirms the session is ended or invalid", async () => {
  readSessionToken.mockResolvedValue("a".repeat(43));
  endCurrentSession.mockResolvedValue("already_invalid");

  await expect(endSessionAction()).rejects.toThrow("redirect:/login");

  expect(deleteSessionCookie).toHaveBeenCalledOnce();
});

it("keeps the local cookie when revocation has a transport failure", async () => {
  readSessionToken.mockResolvedValue("a".repeat(43));
  endCurrentSession.mockRejectedValue(new TypeError("fetch failed"));

  await expect(endSessionAction()).resolves.toEqual({ error: "退出失败，请稍后重试。" });

  expect(deleteSessionCookie).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
});
