import {
  FAKE_JOB_DISCOVERY_ADAPTER,
  FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER,
  FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
} from "@job-copilot/contracts/agent-runs";
import type { SourceCapabilityDeclaration } from "@job-copilot/contracts/source-capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";
import { GreenhouseJobDiscoveryAdapter } from "./greenhouse-job-discovery-adapter.js";
import { GreenhouseTrustedSourceAdapter } from "./greenhouse-trusted-source-adapter.js";
import { FakePublicSourceHealthAdapter } from "./fake-public-source-health-adapter.js";
import { GreenhouseSourceHealthAdapter } from "./greenhouse-source-health-adapter.js";

type SourceCapabilityAdapter = {
  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration;
};

function expectFormalBetaCapabilities(adapter: SourceCapabilityAdapter, sourceId: string, identity: { adapter: string; adapterVersion: string }) {
  expect(adapter.declareCapabilities({ sourceId })).toEqual({
    sourceId,
    ...identity,
    contractVersion: "source-capabilities-v1",
    capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"],
  });
}

describe("Source capability adapter contract", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("Fake 与 Greenhouse Adapter 声明精确身份的正式 Beta 前能力契约且不访问真实站点", () => {
    vi.stubEnv("APP_ENV", "test");
    expectFormalBetaCapabilities(new FakeJobDiscoveryAdapter(), "fake:aurora-careers", { adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION });
    expectFormalBetaCapabilities(new GreenhouseJobDiscoveryAdapter(), "greenhouse:acme", { adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION });
    expectFormalBetaCapabilities(new GreenhouseTrustedSourceAdapter(), "greenhouse:acme", { adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION });
    expectFormalBetaCapabilities(new FakePublicSourceHealthAdapter(), "greenhouse:acme", { adapter: FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION });
    expectFormalBetaCapabilities(new GreenhouseSourceHealthAdapter(), "greenhouse:acme", { adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION });
  });
});
