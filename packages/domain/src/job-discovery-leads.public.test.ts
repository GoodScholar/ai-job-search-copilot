import * as publicApi from "@job-copilot/domain/job-discovery-leads";
import { describe, expect, it } from "vitest";

describe("job discovery lead public API", () => {
  it("不向包消费者暴露终态化或事务注入 bypass", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "JobDiscoveryLeadError",
      "createJobDiscoveryLeadRepository",
    ]);
    const repository = publicApi.createJobDiscoveryLeadRepository as unknown as (input: unknown) => Record<string, unknown>;
    expect(Object.keys(repository({})).sort()).toEqual([
      "getAttribution",
      "getLead",
      "recordPending",
    ]);
  });
});
