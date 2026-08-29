import { z } from "zod";

export const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";

const positiveInteger = z.int().min(1);
const nonnegativeInteger = z.int().nonnegative();
const dailyTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const canonicalCompanyName = z.string().trim().min(1).max(200);
const careersUrl = z.string().trim().min(1).max(2_048);
const allowedDomain = z.string().trim().toLowerCase().min(1).max(253);
const allowedDomains = z.array(allowedDomain).min(1).max(20).refine(
  (values) => new Set(values).size === values.length,
  { message: "allowed domains must be unique" },
);

export const JobDiscoveryScheduleSchema = z.object({
  scheduleId: z.uuid(),
  targetId: z.uuid(),
  version: positiveInteger,
  state: z.enum(["enabled", "disabled"]),
  dailyTime,
  timeZone: z.literal("Asia/Shanghai"),
  nextRunAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
}).strict();

export const SetJobDiscoveryScheduleCommandSchema = z.object({
  expectedVersion: nonnegativeInteger,
  state: z.enum(["enabled", "disabled"]),
  dailyTime,
}).strict();

/** 计划页面只需要来源是否可以执行，绝不返回来源 URL 或授权域名。 */
export const JobDiscoverySourceSupportSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("executable"), supportedSourceCount: positiveInteger }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("policy_required"), message: z.literal("需允许 boards-api.greenhouse.io") }).strict(),
]);

export const JobDiscoveryScheduleResponseSchema = z.object({
  schedule: JobDiscoveryScheduleSchema.nullable(),
  sourceSupport: JobDiscoverySourceSupportSchema,
}).strict();

export const JobDiscoveryScheduleOccurrenceSchema = z.object({
  occurrenceId: z.uuid(),
  scheduleId: z.uuid(),
  targetId: z.uuid(),
  scheduledFor: z.iso.datetime(),
  status: z.enum(["pending", "dispatched", "skipped"]),
  runId: z.uuid().nullable(),
  skipReason: z.enum(["TARGET_INACTIVE", "NO_SUPPORTED_SOURCE", "SOURCE_POLICY_REQUIRED"]).nullable(),
}).strict().superRefine((occurrence, context) => {
  const validOutcome = (occurrence.status === "pending" && occurrence.runId === null && occurrence.skipReason === null)
    || (occurrence.status === "dispatched" && occurrence.runId !== null && occurrence.skipReason === null)
    || (occurrence.status === "skipped" && occurrence.runId === null && occurrence.skipReason !== null);
  if (!validOutcome) context.addIssue({ code: "custom", message: "occurrence outcome must match its status" });
});

export const GreenhousePublicSourceSchema = z.object({
  sourceId: z.string().trim().regex(/^greenhouse:[A-Za-z0-9_-]+$/u),
  watchlistItemId: z.uuid(),
  canonicalCompanyName,
  careersUrl,
  allowedDomains,
  boardToken: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(128),
}).strict().superRefine((source, context) => {
  const derived = classifyGreenhousePublicSource({
    itemId: source.watchlistItemId,
    canonicalCompanyName: source.canonicalCompanyName,
    careersUrl: source.careersUrl,
    allowedDomains: source.allowedDomains,
  });
  if (derived.kind !== "supported" || derived.source.sourceId !== source.sourceId || derived.source.boardToken !== source.boardToken) {
    context.addIssue({ code: "custom", message: "source must be a supported exact-host-authorized Greenhouse board" });
  }
});

type GreenhouseSourceCandidate = z.input<typeof GreenhousePublicSourceSchema> extends infer _Source
  ? { itemId: string; canonicalCompanyName: string; careersUrl: string; allowedDomains: string[] }
  : never;

export type GreenhousePublicSource = z.infer<typeof GreenhousePublicSourceSchema>;
export type GreenhouseSourceClassification =
  | { kind: "supported"; source: GreenhousePublicSource }
  | { kind: "policy_required"; code: "GREENHOUSE_API_HOST_NOT_ALLOWED" }
  | { kind: "unsupported" };

export function classifyGreenhousePublicSource(candidate: GreenhouseSourceCandidate): GreenhouseSourceClassification {
  let url: URL;
  try {
    url = new URL(candidate.careersUrl);
  } catch {
    return { kind: "unsupported" };
  }
  const host = url.hostname.toLowerCase();
  const supportedHost = host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io";
  const tokenMatch = /^\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.port !== "" || url.search !== "" || url.hash !== "" || !supportedHost || !tokenMatch) return { kind: "unsupported" };
  if (!candidate.allowedDomains.includes(GREENHOUSE_API_HOST)) {
    return { kind: "policy_required", code: "GREENHOUSE_API_HOST_NOT_ALLOWED" };
  }
  return {
    kind: "supported",
    source: {
      sourceId: `greenhouse:${tokenMatch[1]}`,
      watchlistItemId: candidate.itemId,
      canonicalCompanyName: candidate.canonicalCompanyName,
      careersUrl: candidate.careersUrl,
      allowedDomains: candidate.allowedDomains,
      boardToken: tokenMatch[1]!,
    },
  };
}

export type JobDiscoverySchedule = z.infer<typeof JobDiscoveryScheduleSchema>;
export type SetJobDiscoveryScheduleCommand = z.infer<typeof SetJobDiscoveryScheduleCommandSchema>;
export type JobDiscoverySourceSupport = z.infer<typeof JobDiscoverySourceSupportSchema>;
export type JobDiscoveryScheduleResponse = z.infer<typeof JobDiscoveryScheduleResponseSchema>;
export type JobDiscoveryScheduleOccurrence = z.infer<typeof JobDiscoveryScheduleOccurrenceSchema>;
