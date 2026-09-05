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

  it("允许未配置模型服务的本地部署，并保留运行服务配置在服务端", () => {
    expect(parseRuntimeConfig({ APP_ENV: "local", AUTH_MODE: "wechat" }).openAi).toEqual({ apiKey: undefined, endpoint: undefined, organization: undefined, project: undefined });
    expect(parseRuntimeConfig({ APP_ENV: "test", AUTH_MODE: "dev", DEV_AUTH_SHARED_SECRET: "01234567890123456789012345678901", OPENAI_API_KEY: "server-only-key", OPENAI_ENDPOINT: "https://models.example.test", OPENAI_ORGANIZATION: "org-private", OPENAI_PROJECT: "project-private" }).openAi).toEqual({ apiKey: "server-only-key", endpoint: "https://models.example.test", organization: "org-private", project: "project-private" });
  });
});
