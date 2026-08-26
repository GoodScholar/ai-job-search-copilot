import { expect, it } from "vitest";
import { getPublicAuthMode, resolveInternalReturnTo, resolveLoginReturnTo } from "./auth-mode";

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
  expect(resolveInternalReturnTo("/jobs?sort=match#top")).toBe("/jobs?sort=match#top");
  expect(resolveInternalReturnTo("/")).toBe("/");
  expect(resolveInternalReturnTo("//example.com")).toBe("/");
  expect(resolveInternalReturnTo("https://example.com")).toBe("/");
  expect(resolveInternalReturnTo(["/profile"])).toBe("/");
  expect(resolveInternalReturnTo("")).toBe("/");
  expect(resolveInternalReturnTo(undefined)).toBe("/");
  expect(resolveInternalReturnTo(null)).toBe("/");
});

it("rejects values that a browser could resolve outside the site", () => {
  expect(resolveInternalReturnTo("/\\evil.example")).toBe("/");
  expect(resolveInternalReturnTo("/\\\\evil.example")).toBe("/");
  expect(resolveInternalReturnTo("/jobs\nnext")).toBe("/");
  expect(resolveInternalReturnTo("/jobs\u0000next")).toBe("/");
  expect(resolveInternalReturnTo("//evil.example/path")).toBe("/");
  expect(resolveInternalReturnTo("https://evil.example/path")).toBe("/");
});

it("defaults login to the authenticated home", () => {
  expect(resolveLoginReturnTo(undefined)).toBe("/home");
  expect(resolveLoginReturnTo("https://evil.example")).toBe("/home");
  expect(resolveLoginReturnTo("/profile")).toBe("/profile");
});
