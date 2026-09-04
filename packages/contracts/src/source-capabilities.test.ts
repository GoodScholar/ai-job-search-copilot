import { describe, expect, it } from "vitest";
import { SourceCapabilityDeclarationSchema, SourceCapabilityRejectionSchema } from "./source-capabilities";

describe("SourceCapabilityDeclarationSchema", () => {
  it("声明版本化来源标识与正式 Beta 前四项稳定能力", () => {
    const result = SourceCapabilityDeclarationSchema.parse({
      sourceId: "greenhouse:acme",
      adapter: "greenhouse",
      adapterVersion: "greenhouse-job-board-v2",
      contractVersion: "source-capabilities-v1",
      capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"],
    });

    expect(result.capabilities).toEqual(["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"]);
  });

  it("拒绝以健康状态替代稳定能力声明", () => {
    expect(SourceCapabilityDeclarationSchema.safeParse({
      sourceId: "greenhouse:acme",
      adapter: "greenhouse",
      adapterVersion: "greenhouse-job-board-v2",
      contractVersion: "source-capabilities-v1",
      capabilities: ["active_discovery"],
      health: "healthy",
    }).success).toBe(false);
  });

  it("拒绝结构只接受稳定原因、影响、重试资格和有限建议动作", () => {
    const rejection = {
      reasonCode: "SOURCE_CAPABILITY_UNSUPPORTED",
      impact: { scope: "entire_source", affectedCount: null },
      retryable: false,
      suggestedActions: ["review_source_capabilities"],
    };

    expect(SourceCapabilityRejectionSchema.safeParse(rejection).success).toBe(true);
    expect(SourceCapabilityDeclarationSchema.safeParse({
      sourceId: "greenhouse:acme", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", contractVersion: "source-capabilities-v1", capabilities: ["unknown_action"],
    }).success).toBe(false);
    expect(SourceCapabilityRejectionSchema.safeParse({ ...rejection, reasonCode: "UNKNOWN" }).success).toBe(false);
    expect(SourceCapabilityRejectionSchema.safeParse({ ...rejection, suggestedActions: ["unknown_action"] }).success).toBe(false);
    expect(SourceCapabilityRejectionSchema.safeParse({ ...rejection, extra: true }).success).toBe(false);
  });
});
