import { describe, expect, it } from "vitest";
import type { SourceCapability } from "@job-copilot/contracts/source-capabilities";
import { authorizeSourceAction, SourceExecutionActionSchema } from "./source-capabilities";

const declaration = {
  sourceId: "greenhouse:acme",
  adapter: "greenhouse",
  adapterVersion: "greenhouse-job-board-v2",
  contractVersion: "source-capabilities-v1" as const,
  capabilities: ["active_discovery"] as SourceCapability[],
};

describe("authorizeSourceAction", () => {
  it("执行动作 schema 排除仅声明的安全打开能力", () => {
    expect(SourceExecutionActionSchema.safeParse("safe_open_original_page").success).toBe(false);
    expect(SourceExecutionActionSchema.safeParse("read_details").success).toBe(true);
  });

  it("不因来源名称或历史健康推测未声明的详情读取权限", () => {
    expect(authorizeSourceAction({ declaration, action: "read_details", expected: { sourceId: "greenhouse:acme", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2" } })).toEqual({
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
    expect(authorizeSourceAction({ declaration, action: "active_discovery", expected: { sourceId: "greenhouse:acme", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2" } })).toEqual({ allowed: true });
  });

  it("声明身份与实际 Adapter 不一致时拒绝，不能以同名来源放宽授权", () => {
    expect(authorizeSourceAction({ declaration, action: "active_discovery", expected: { sourceId: "greenhouse:acme", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v9" } })).toEqual({
      allowed: false,
      failure: {
        reasonCode: "SOURCE_CAPABILITY_DECLARATION_MISMATCH",
        impact: { scope: "entire_source", affectedCount: null },
        retryable: false,
        suggestedActions: ["review_source_capabilities"],
      },
    });
  });
});
