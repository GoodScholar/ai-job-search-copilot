import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sessionCookieOptions } from "./session-cookie";

it("uses secure cookie attributes without exposing account data", () => {
  const expiresAt = new Date("2026-09-02T08:00:00.000Z");

  expect(sessionCookieOptions({ appEnv: "production", expiresAt })).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
});

it("does not require secure cookies outside production", () => {
  const expiresAt = new Date("2026-09-02T08:00:00.000Z");

  expect(sessionCookieOptions({ appEnv: "local", expiresAt }).secure).toBe(false);
});
