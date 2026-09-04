import { describe, expect, it } from "vitest";
import { SourceCapabilityDeclarationSchema, SourceCapabilityRejectionSchema, SourceCapabilityProjectionOverviewSchema } from "./source-capabilities";

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

  it("公开能力投影绑定当前 Watchlist 项目，且身份失配有独立稳定拒绝", () => {
    expect(SourceCapabilityProjectionOverviewSchema.safeParse({
      targetId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", watchlistVersion: 1,
      sources: [{ watchlistItemId: "87ccabf1-f5fe-430c-9129-df14e4789ec0", name: "曙光", state: "enabled", declaration: {
        sourceId: "greenhouse:aurora", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery"],
      } }],
    }).success).toBe(true);
    expect(SourceCapabilityRejectionSchema.safeParse({
      reasonCode: "SOURCE_CAPABILITY_DECLARATION_MISMATCH", impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"],
    }).success).toBe(true);
  });
});
