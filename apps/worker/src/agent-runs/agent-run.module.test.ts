import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryAdapter } from "./agent-run.module.js";
import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";

describe("AgentRunModule", () => {
  it.each(["local", "test"])("%s 环境显式允许确定性 Fake", (appEnv) => {
    expect(createConfiguredJobDiscoveryAdapter({ APP_ENV: appEnv })).toBeInstanceOf(FakeJobDiscoveryAdapter);
  });

  it.each([undefined, "production", "development", "LOCAL", "tesst"])(
    "APP_ENV=%s 时 fail-closed 拒绝 Fake",
    (appEnv) => {
      expect(() => createConfiguredJobDiscoveryAdapter(appEnv === undefined ? {} : { APP_ENV: appEnv }))
        .toThrow("JobDiscoveryAdapter 环境未获允许");
    },
  );
});
