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
});
