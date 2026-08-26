import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "./runtime-config";

describe("runtime config", () => {
  it("rejects dev auth in production", () => {
    expect(() => parseRuntimeConfig({
      APP_ENV: "production",
      AUTH_MODE: "dev",
      DEV_AUTH_SHARED_SECRET: "01234567890123456789012345678901",
    })).toThrow(/正式环境不能启用 Dev Auth/);
  });

  it("requires a sufficiently long dev auth shared secret", () => {
    expect(() => parseRuntimeConfig({
      APP_ENV: "test",
      AUTH_MODE: "dev",
      DEV_AUTH_SHARED_SECRET: "short-secret",
    })).toThrow();
  });
});
