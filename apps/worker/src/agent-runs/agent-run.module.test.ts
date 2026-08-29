import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryAdapter } from "./agent-run.module.js";
import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";

describe("AgentRunModule", () => {
  it("本地与测试环境使用确定性 Fake，生产环境拒绝未配置的真实 Adapter", () => {
    expect(createConfiguredJobDiscoveryAdapter({ APP_ENV: "test" })).toBeInstanceOf(FakeJobDiscoveryAdapter);
    expect(() => createConfiguredJobDiscoveryAdapter({ APP_ENV: "production" }))
      .toThrow("生产 JobDiscoveryAdapter 尚未配置");
  });
});
