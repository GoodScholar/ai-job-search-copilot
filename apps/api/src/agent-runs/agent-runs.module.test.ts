import { describe, expect, it } from "vitest";
import type { Database } from "@job-copilot/database";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import type { RunPreflightEvaluator } from "../run-preflight/run-preflight.tokens.js";

import { AUDIT_TRAIL } from "../auth/auth.module.js";
import { DATABASE } from "../config/runtime-config.module.js";
import { RUN_PREFLIGHT_EVALUATOR } from "../run-preflight/run-preflight.tokens.js";
import { AgentRunsModule, createConfiguredJobDiscoveryExecutionMode } from "./agent-runs.module.js";
import { AGENT_RUN_QUEUE_PORT, RECOMMENDATION_RUN_COMMANDS } from "./agent-runs.tokens.js";

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

  it.each([
    { APP_ENV: "production", E2E_AGENT_RUN_SCENARIOS: '{"sentinel":"retry_once"}' },
    { APP_ENV: "local", E2E_AGENT_RUN_SCENARIOS: '{"sentinel":"retry_once"}' },
    { APP_ENV: "production", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"sentinel":{}}' },
    { APP_ENV: "local", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"sentinel":{}}' },
    { APP_ENV: "production", ANYSEARCH_BASE_URL: "https://sentinel.invalid" },
  ])("与 Worker 一样拒绝 test-only 或 provider override: %o", (environment) => {
    expect(() => createConfiguredJobDiscoveryExecutionMode(environment)).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  });

  it.each([undefined, "", "   "])("test 下空白 health scenario 保持 Fake: %j", (scenario) => {
    expect(createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "test", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: scenario })).toBe("fake");
  });

  it.each([
    { E2E_AGENT_RUN_SCENARIOS: "{" },
    { E2E_AGENT_RUN_SCENARIOS: '{"not-a-uuid":"retry_once"}' },
    { E2E_AGENT_RUN_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":"unknown"}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "{" },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"not-a-uuid":{"greenhouse:example":"healthy"}}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":{"invalid-source":"healthy"}}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":{"greenhouse:example":"unknown"}}' },
  ])("test 入口也拒绝两种 scenario 的非法值且不泄露内容: %o", (scenario) => {
    const sentinel = JSON.stringify(scenario);
    expect(() => createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "test", ...scenario })).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    try { createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "test", ...scenario }); } catch (error) { expect(String(error)).not.toContain(sentinel); }
  });

  it("推荐 commands 在同一模块声明共享依赖、导出 token，并可由该 factory 创建", () => {
    const providers = Reflect.getMetadata("providers", AgentRunsModule) as Array<{ provide?: symbol; inject?: unknown[]; useFactory?: (...deps: unknown[]) => unknown }>;
    const recommendation = providers.find((provider) => provider.provide === RECOMMENDATION_RUN_COMMANDS);
    expect(recommendation?.inject).toEqual([DATABASE, AGENT_RUN_QUEUE_PORT, AUDIT_TRAIL, RUN_PREFLIGHT_EVALUATOR]);
    expect(Reflect.getMetadata("exports", AgentRunsModule)).toContain(RECOMMENDATION_RUN_COMMANDS);

    const originalAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = "test";
    try {
      const commands = recommendation?.useFactory?.(
        {} as Database,
        {} as AgentRunQueue,
        {} as AuditTrail,
        {} as RunPreflightEvaluator,
      );
      expect(commands).toMatchObject({ start: expect.any(Function) });
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
    }
  });
});
