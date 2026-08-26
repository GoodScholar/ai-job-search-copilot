import { expect, it } from "vitest";
import { getPublicAuthMode, resolveInternalReturnTo } from "./auth-mode";

it("defaults to dev auth locally", () => {
  expect(getPublicAuthMode({})).toBe("dev");
});

it("accepts the reviewed WeChat mode", () => {
  expect(getPublicAuthMode({ NEXT_PUBLIC_AUTH_MODE: "wechat" })).toBe("wechat");
});

it("falls back to dev for unreviewed public auth modes", () => {
  expect(getPublicAuthMode({ NEXT_PUBLIC_AUTH_MODE: "oauth" })).toBe("dev");
});

it("only resolves a single-slash internal return path", () => {
  expect(resolveInternalReturnTo("/profile")).toBe("/profile");
  expect(resolveInternalReturnTo("/")).toBe("/");
  expect(resolveInternalReturnTo("//example.com")).toBe("/");
  expect(resolveInternalReturnTo("https://example.com")).toBe("/");
  expect(resolveInternalReturnTo(["/profile"])).toBe("/");
  expect(resolveInternalReturnTo("")).toBe("/");
  expect(resolveInternalReturnTo(undefined)).toBe("/");
  expect(resolveInternalReturnTo(null)).toBe("/");
});
