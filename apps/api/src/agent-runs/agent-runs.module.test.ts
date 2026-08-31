import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryExecutionMode } from "./agent-runs.module.js";

describe("AgentRunsModule", () => {
  it.each([
    [{ APP_ENV: "production" }, "layered_public"],
    [{ APP_ENV: "test", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "fake"],
    [{ APP_ENV: "local" }, "fake"],
    [{ APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "greenhouse"],
  ] as const)("为 %o 选择新 Agent 运行的 %s 执行模式", (environment, expected) => {
    expect(createConfiguredJobDiscoveryExecutionMode(environment)).toBe(expected);
  });

  it("拒绝未知环境，避免 API 在未判定模式下创建新运行", () => {
    expect(() => createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "staging" })).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  });

  it.each(["fake", "greenhouse"])('production 拒绝 PUBLIC_JOB_DISCOVERY_ADAPTER=%s', (adapter) => {
    expect(() => createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "production", PUBLIC_JOB_DISCOVERY_ADAPTER: adapter })).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  });
});
