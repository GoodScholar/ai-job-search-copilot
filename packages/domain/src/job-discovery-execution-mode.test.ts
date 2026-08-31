import { describe, expect, it } from "vitest";
import { resolveJobDiscoveryRuntimeConfig } from "./job-discovery-execution-mode";

describe("job discovery runtime config", () => {
  it("在 test 一次归一化两种 scenario，并把空白视为普通 Fake", () => {
    expect(resolveJobDiscoveryRuntimeConfig({ APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: "   ", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "" }))
      .toMatchObject({ executionMode: "fake", agentRunScenarios: {}, sourceHealthScenarios: {} });
    expect(resolveJobDiscoveryRuntimeConfig({
      APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":"retry_once"}',
      E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"22222222-2222-4222-8222-222222222222":{"greenhouse:example":"healthy"}}',
    })).toMatchObject({ executionMode: "greenhouse", agentRunScenarios: { "11111111-1111-4111-8111-111111111111": "retry_once" }, sourceHealthScenarios: { "22222222-2222-4222-8222-222222222222": { "greenhouse:example": "healthy" } } });
  });

  it("只在 test 通过固定版本的 Fake AnySearch phase 选择 layered public", () => {
    expect(resolveJobDiscoveryRuntimeConfig({
      APP_ENV: "test",
      E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1",
    } as NodeJS.ProcessEnv)).toMatchObject({
      executionMode: "layered_public",
      anysearchPublicJobPhase: "fake-anysearch-public-job-v1",
    });
  });

  it.each([
    { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "" },
    { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v2" },
    { APP_ENV: "local", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1" },
    { APP_ENV: "production", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1" },
  ])("对非法或非测试 Fake AnySearch phase 稳定 fail closed", (environment) => {
    const sentinel = environment.E2E_ANYSEARCH_PUBLIC_JOB_PHASE;
    expect(() => resolveJobDiscoveryRuntimeConfig(environment as NodeJS.ProcessEnv)).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    try { resolveJobDiscoveryRuntimeConfig(environment as NodeJS.ProcessEnv); } catch (error) { expect(String(error)).not.toContain(sentinel); }
  });
});
