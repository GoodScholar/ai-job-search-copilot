import { z } from "zod";
import { AGENT_RUN_BUDGET, DEEP_MATCH_AGENT_RUN_BUDGET, PUBLIC_JOB_DISCOVERY_BUDGET } from "./agent-runs";

const nonnegativeInteger = z.int().nonnegative();
const dailyTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const provider = z.enum(["anysearch"]);
const hardLimitMessage = "不得超过系统硬上限，请填写更小的数值";

export const AccountRunBudgetSchema = z.object({
  maxActiveDurationMs: nonnegativeInteger,
  maxAttempts: nonnegativeInteger,
  maxToolCalls: nonnegativeInteger,
  maxResults: nonnegativeInteger,
  maxModelCalls: nonnegativeInteger,
  maxTokens: nonnegativeInteger,
}).strict();

export const AccountRunPolicyDiscoverySchema = z.object({
  trustedSourceLimit: nonnegativeInteger,
  publicQueryLimit: nonnegativeInteger,
  verificationCandidateLimit: nonnegativeInteger,
  enabledProviders: z.array(provider).max(1).refine((values) => new Set(values).size === values.length, "enabled providers must be unique"),
}).strict();

export const AccountRunPolicyBackgroundWindowSchema = z.object({
  start: dailyTime,
  end: dailyTime,
  timeZone: z.literal("Asia/Shanghai"),
}).strict().refine((window) => window.start !== window.end, {
  message: "background window start and end must differ",
  path: ["end"],
});

export const AccountRunPolicySettingsSchema = z.object({
  discovery: AccountRunPolicyDiscoverySchema,
  budgets: z.object({
    publicDiscovery: AccountRunBudgetSchema,
    deepMatch: AccountRunBudgetSchema,
    fake: AccountRunBudgetSchema,
  }).strict(),
  backgroundWindow: AccountRunPolicyBackgroundWindowSchema,
}).strict();

export const AccountRunPolicyHardLimitsSchema = z.object({
  discovery: AccountRunPolicyDiscoverySchema,
  budgets: z.object({ publicDiscovery: AccountRunBudgetSchema, deepMatch: AccountRunBudgetSchema, fake: AccountRunBudgetSchema }).strict(),
  /** 系统允许全天；用户窗口仍须是非空的 [start,end) 区间。 */
  backgroundWindow: z.object({ timeZone: z.literal("Asia/Shanghai"), allowsAllDay: z.literal(true) }).strict(),
}).strict();

export const AccountRunPolicyCommandSchema = z.object({
  expectedVersion: nonnegativeInteger,
  settings: AccountRunPolicySettingsSchema,
}).strict().superRefine((command, context) => {
  const hardLimits = systemAccountRunPolicy().system.hardLimits;
  for (const [dimension, maximum] of Object.entries(hardLimits.discovery)) {
    if (dimension === "enabledProviders") continue;
    const value = command.settings.discovery[dimension as keyof typeof command.settings.discovery];
    if (typeof value === "number" && typeof maximum === "number" && value > maximum) context.addIssue({ code: "custom", path: ["settings", "discovery", dimension], message: hardLimitMessage, params: { reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", maximum, suggestedAction: "reduce_to_system_hard_limit" } });
  }
  const limits = hardLimits.budgets;
  for (const key of ["publicDiscovery", "deepMatch", "fake"] as const) {
    for (const [dimension, maximum] of Object.entries(limits[key])) {
      const value = command.settings.budgets[key][dimension as keyof typeof command.settings.budgets[typeof key]];
      if (value > maximum) context.addIssue({ code: "custom", path: ["settings", "budgets", key, dimension], message: hardLimitMessage, params: { reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", maximum, suggestedAction: "reduce_to_system_hard_limit" } });
    }
  }
});

export const AccountRunPolicyRevisionSchema = z.object({
  revisionNumber: nonnegativeInteger,
  isSystemBaseline: z.boolean(),
  createdAt: z.iso.datetime(),
  settings: AccountRunPolicySettingsSchema,
}).strict();

const systemBudgets = {
  publicDiscovery: PUBLIC_JOB_DISCOVERY_BUDGET,
  deepMatch: DEEP_MATCH_AGENT_RUN_BUDGET,
  fake: AGENT_RUN_BUDGET,
} as const;

const baselineSettings = {
  discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] as ["anysearch"] },
  budgets: systemBudgets,
  backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" as const },
} as const;

const systemHardLimits = {
  discovery: { trustedSourceLimit: 50, publicQueryLimit: 10, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] as ["anysearch"] },
  budgets: systemBudgets,
  backgroundWindow: { timeZone: "Asia/Shanghai" as const, allowsAllDay: true as const },
} as const;

export const AccountRunPolicyResponseSchema = z.object({
  revision: AccountRunPolicyRevisionSchema,
  system: z.object({ defaults: AccountRunPolicySettingsSchema, hardLimits: AccountRunPolicyHardLimitsSchema }).strict(),
  userSettings: AccountRunPolicySettingsSchema.nullable(),
  effective: AccountRunPolicySettingsSchema,
}).strict();

export const AccountRunPolicyHistorySchema = z.object({ revisions: z.array(AccountRunPolicyRevisionSchema).max(100) }).strict();

export type AccountRunPolicySettings = z.infer<typeof AccountRunPolicySettingsSchema>;
export type AccountRunPolicyResponse = z.infer<typeof AccountRunPolicyResponseSchema>;
export type AccountRunPolicyRevision = z.infer<typeof AccountRunPolicyRevisionSchema>;

export function systemAccountRunPolicy(): AccountRunPolicyResponse {
  const settings = structuredClone(baselineSettings);
  return AccountRunPolicyResponseSchema.parse({
    revision: { revisionNumber: 0, isSystemBaseline: true, createdAt: "1970-01-01T00:00:00.000Z", settings },
    system: { defaults: settings, hardLimits: structuredClone(systemHardLimits) },
    userSettings: null,
    effective: settings,
  });
}

export function effectiveAccountRunPolicy(settings: AccountRunPolicySettings | null): AccountRunPolicySettings {
  const system = systemAccountRunPolicy().system;
  if (!settings) return system.defaults;
  return AccountRunPolicySettingsSchema.parse({
    discovery: {
      trustedSourceLimit: Math.min(settings.discovery.trustedSourceLimit, system.hardLimits.discovery.trustedSourceLimit),
      publicQueryLimit: Math.min(settings.discovery.publicQueryLimit, system.hardLimits.discovery.publicQueryLimit),
      verificationCandidateLimit: Math.min(settings.discovery.verificationCandidateLimit, system.hardLimits.discovery.verificationCandidateLimit),
      enabledProviders: settings.discovery.enabledProviders.filter((value) => system.hardLimits.discovery.enabledProviders.includes(value)),
    },
    budgets: Object.fromEntries((Object.keys(system.hardLimits.budgets) as Array<keyof typeof system.hardLimits.budgets>).map((key) => [key, Object.fromEntries(
      Object.entries(settings.budgets[key]).map(([dimension, value]) => [dimension, Math.min(value, system.hardLimits.budgets[key][dimension as keyof typeof system.hardLimits.budgets[typeof key]])]),
    )])) as AccountRunPolicySettings["budgets"],
    backgroundWindow: settings.backgroundWindow,
  });
}

export const AccountRunPolicyProblemIssueSchema = z.object({
  reasonCode: z.enum(["ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID"]),
  path: z.array(z.string()).min(1),
  maximum: z.number().int().nonnegative().nullable(),
  suggestedAction: z.string().min(1),
}).strict();
export const AccountRunPolicyProblemSchema = z.object({
  code: z.enum(["ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID", "ACCOUNT_RUN_POLICY_VERSION_CONFLICT"]),
  message: z.string().min(1),
  issues: z.array(AccountRunPolicyProblemIssueSchema),
}).strict();
export type AccountRunPolicyProblem = z.infer<typeof AccountRunPolicyProblemSchema>;

type AccountRunPolicyZodIssue = {
  path: PropertyKey[];
  params?: { reasonCode?: unknown; maximum?: unknown; suggestedAction?: unknown };
};

/** 仅投影可安全展示的策略校验错误；其余 Zod 输入错误仍由调用方按通用 400 处理。 */
export function accountRunPolicyProblemFromZodIssues(issues: readonly AccountRunPolicyZodIssue[]): AccountRunPolicyProblem | null {
  const projected: Array<z.infer<typeof AccountRunPolicyProblemIssueSchema>> = [];
  for (const issue of issues) {
    if (issue.params?.reasonCode === "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED" && typeof issue.params.maximum === "number" && typeof issue.params.suggestedAction === "string") {
      projected.push({ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: issue.path.map(String), maximum: issue.params.maximum, suggestedAction: issue.params.suggestedAction });
    } else if (issue.path.join(".") === "settings.backgroundWindow.end") {
      projected.push({ reasonCode: "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID", path: issue.path.map(String), maximum: null, suggestedAction: "choose_a_non_empty_background_window" });
    }
  }
  if (!projected.length) return null;
  const code = projected[0]!.reasonCode;
  return AccountRunPolicyProblemSchema.parse({
    code,
    message: code === "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED" ? "运行策略超过系统硬上限" : "后台运行时间窗口无效",
    issues: projected,
  });
}
