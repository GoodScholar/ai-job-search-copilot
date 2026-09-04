import { describe, expect, it } from "vitest";
import type { SourceCapability } from "@job-copilot/contracts/source-capabilities";
import { authorizeSourceAction } from "./source-capabilities";

const declaration = {
  sourceId: "greenhouse:acme",
  adapter: "greenhouse",
  adapterVersion: "greenhouse-job-board-v2",
  contractVersion: "source-capabilities-v1" as const,
  capabilities: ["active_discovery"] as SourceCapability[],
};

describe("authorizeSourceAction", () => {
  it("不因来源名称或历史健康推测未声明的详情读取权限", () => {
    expect(authorizeSourceAction({ declaration, action: "read_details" })).toEqual({
      allowed: false,
      failure: {
        reasonCode: "SOURCE_CAPABILITY_UNSUPPORTED",
        impact: { scope: "entire_source", affectedCount: null },
        retryable: false,
        suggestedActions: ["review_source_capabilities"],
      },
    });
  });

  it("仅允许声明的动作", () => {
    expect(authorizeSourceAction({ declaration, action: "active_discovery" })).toEqual({ allowed: true });
  });
});
