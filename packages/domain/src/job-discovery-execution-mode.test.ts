import { describe, expect, it } from "vitest";
import { fakeAnysearchPublicJobMissingKeyPhase, fakeAnysearchPublicJobPhase, isConfiguredFakeAnysearchPublicJobPhase, isFakeAnysearchPublicJobPhase } from "../../../scripts/fake-anysearch-test-phase-policy.mjs";
import { FAKE_ANYSEARCH_PUBLIC_JOB_MISSING_KEY_PHASE, FAKE_ANYSEARCH_PUBLIC_JOB_PHASE, resolveJobDiscoveryRuntimeConfig } from "./job-discovery-execution-mode";

describe("job discovery runtime config", () => {
  it("共享测试 phase policy 与不可变 domain 枚举逐项一致", () => {
    expect({ fakeAnysearchPublicJobPhase, fakeAnysearchPublicJobMissingKeyPhase }).toEqual({
      fakeAnysearchPublicJobPhase: FAKE_ANYSEARCH_PUBLIC_JOB_PHASE,
      fakeAnysearchPublicJobMissingKeyPhase: FAKE_ANYSEARCH_PUBLIC_JOB_MISSING_KEY_PHASE,
    });
    expect(isConfiguredFakeAnysearchPublicJobPhase(fakeAnysearchPublicJobPhase)).toBe(true);
    expect(isConfiguredFakeAnysearchPublicJobPhase(fakeAnysearchPublicJobMissingKeyPhase)).toBe(false);
    expect(isFakeAnysearchPublicJobPhase("fake-anysearch-public-job-v2")).toBe(false);
  });

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

  it("test 的版本化 missing-key phase 同样选择 layered public，且不退回普通 Fake", () => {
    expect(resolveJobDiscoveryRuntimeConfig({
      APP_ENV: "test",
      E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-missing-key-v1",
    } as NodeJS.ProcessEnv)).toMatchObject({
      executionMode: "layered_public",
      anysearchPublicJobPhase: "fake-anysearch-public-job-missing-key-v1",
    });
  });

  it("只从精确 phase 派生固定 AnySearch fixture endpoint，不信任环境中的任意 base 或 page origin", () => {
    expect(resolveJobDiscoveryRuntimeConfig({
      APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1",
    } as NodeJS.ProcessEnv)).toMatchObject({
      anysearchFixtureOrigin: "http://127.0.0.1:39334",
    });
    for (const environment of [
      { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1", ANYSEARCH_BASE_URL: "http://127.0.0.1:39999" },
      { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1", ANYSEARCH_PROVIDER_BASE_URL: "http://fixture.invalid" },
      { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1", JOB_PAGE_FETCHER_TEST_ORIGIN: "http://127.0.0.1:39333" },
      { APP_ENV: "test", ANYSEARCH_BASE_URL: "http://127.0.0.1:39334" },
    ]) expect(() => resolveJobDiscoveryRuntimeConfig(environment as NodeJS.ProcessEnv)).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    expect(resolveJobDiscoveryRuntimeConfig({ APP_ENV: "test", JOB_PAGE_FETCHER_TEST_ORIGIN: "http://127.0.0.1:39333" } as NodeJS.ProcessEnv).executionMode).toBe("fake");
  });

  it.each([
    { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "" },
    { APP_ENV: "test", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v2" },
    { APP_ENV: "local", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1" },
    { APP_ENV: "production", E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1" },
    { APP_ENV: "local", JOB_PAGE_FETCHER_TEST_ORIGIN: "http://127.0.0.1:39334" },
    { APP_ENV: "production", ANYSEARCH_PROVIDER_BASE_URL: "http://sentinel.invalid" },
  ])("对非法或非测试 Fake AnySearch phase 稳定 fail closed", (environment) => {
    const sentinel = environment.E2E_ANYSEARCH_PUBLIC_JOB_PHASE;
    expect(() => resolveJobDiscoveryRuntimeConfig(environment as NodeJS.ProcessEnv)).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    try { resolveJobDiscoveryRuntimeConfig(environment as NodeJS.ProcessEnv); } catch (error) { if (sentinel) expect(String(error)).not.toContain(sentinel); }
  });
});
