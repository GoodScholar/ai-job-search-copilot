import { describe, expect, it } from "vitest";
import { AccountRunPolicyCommandSchema, AccountRunPolicyResponseSchema, systemAccountRunPolicy } from "./account-run-policies";

const settings = () => ({
  discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] },
  budgets: {
    publicDiscovery: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
    deepMatch: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000 },
    fake: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
  }, backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" },
});

describe("账户运行策略契约", () => {
  it("给未保存设置的账户返回 revision 0 系统基线和最终生效值", () => {
    expect(AccountRunPolicyResponseSchema.parse(systemAccountRunPolicy())).toMatchObject({
      revision: { revisionNumber: 0, isSystemBaseline: true },
      system: { defaults: { discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10 } }, hardLimits: { discovery: { publicQueryLimit: 10 }, backgroundWindow: { allowsAllDay: true } } },
      effective: { discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10 } },
      userSettings: null,
    });
  });

  it("分别以稳定原因拒绝空窗口和每一个超过硬上限的完整配置", () => {
    expect(() => AccountRunPolicyCommandSchema.parse({ expectedVersion: 0, settings: { ...settings(), backgroundWindow: { start: "08:00", end: "08:00", timeZone: "Asia/Shanghai" } } })).toThrow(/background window start and end must differ/u);
    const queryError = AccountRunPolicyCommandSchema.safeParse({ expectedVersion: 0, settings: { ...settings(), discovery: { ...settings().discovery, publicQueryLimit: 11 } } });
    expect(queryError.success).toBe(false);
    expect(queryError.error?.issues).toContainEqual(expect.objectContaining({ path: ["settings", "discovery", "publicQueryLimit"], params: { reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", maximum: 10, suggestedAction: "reduce_to_system_hard_limit" } }));
    const toolError = AccountRunPolicyCommandSchema.safeParse({ expectedVersion: 0, settings: { ...settings(), budgets: { ...settings().budgets, publicDiscovery: { ...settings().budgets.publicDiscovery, maxToolCalls: 61 } } } });
    expect(toolError.success).toBe(false);
    expect(toolError.error?.issues).toContainEqual(expect.objectContaining({ path: ["settings", "budgets", "publicDiscovery", "maxToolCalls"], params: { reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", maximum: 60, suggestedAction: "reduce_to_system_hard_limit" } }));
  });
});
