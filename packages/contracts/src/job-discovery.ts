import { z } from "zod";
import { SourceCapabilityImpactSchema, SourceCapabilitySuggestedActionSchema } from "./source-capabilities";
import { GreenhousePublicSourceSchema } from "./job-discovery-schedules";
import { JobTargetConstraintsSchema } from "./job-targets";
import { isPublicJobDiscoveryHostname, SafeNormalizedPublicJobUrlSchema } from "./public-job-url-policy";

export {
  isLexicallyValidDnsHostname,
  isPublicJobDiscoveryHostname,
  isPublicJobIdentityParameterName,
  isPublicJobIdentityValue,
  PublicJobIdentityParameterNames,
  PUBLIC_JOB_SOURCE_TAXONOMY_POLICY_VERSION,
  OfficialPublicJobAtsHosts,
  isOfficialPublicJobAtsHost,
  SafeNormalizedPublicJobUrlSchema,
} from "./public-job-url-policy";

export const LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION = "layered-public-job-discovery-v1";
export const LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER = "layered-public";
export const LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION = "layered-public-job-discovery-v1";
export const LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION = "job-discovery-result-v4";
export const LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION = "layered-public-job-discovery-rules-v1";
export const LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST = [
  "job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch",
] as const;

const positiveInteger = z.int().min(1);
const nonnegativeInteger = z.int().nonnegative();
const stableFingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueQueryId = z.uuid();
const stableCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);
export const PublicJobDiscoverySourceTypeSchema = z.enum([
  "company_careers", "recruitment_platform", "wechat_recruitment_h5", "public_web",
]);
export const PublicJobDiscoveryQueryKindSchema = z.enum(["general", "site_constrained", "target_company"]);
export const AnySearchProviderErrorCodeSchema = z.enum([
  "ANYSEARCH_NOT_CONFIGURED",
  "ANYSEARCH_AUTH_FAILED",
  "ANYSEARCH_RATE_LIMITED",
  "ANYSEARCH_QUOTA_EXHAUSTED",
  "ANYSEARCH_TIMEOUT",
  "ANYSEARCH_CANCELLED",
  "ANYSEARCH_UNAVAILABLE",
  "ANYSEARCH_INVALID_RESPONSE",
  "ANYSEARCH_POLICY_REJECTED",
]);
export const AnySearchProviderHttpStatusSchema = z.union([
  z.literal(400), z.literal(401), z.literal(402), z.literal(403), z.literal(415), z.literal(429),
  z.literal(500), z.literal(502), z.literal(503), z.literal(504), z.null(),
]);
export const AnySearchProviderErrorSchema = z.object({
  code: AnySearchProviderErrorCodeSchema,
  retryable: z.boolean(),
  httpStatus: AnySearchProviderHttpStatusSchema,
}).strict().superRefine((error, context) => {
  if (error.code === "ANYSEARCH_QUOTA_EXHAUSTED" && error.httpStatus !== 402) {
    context.addIssue({ code: "custom", path: ["httpStatus"], message: "quota exhaustion must retain HTTP 402" });
  }
  if (error.code === "ANYSEARCH_RATE_LIMITED" && error.httpStatus !== 429) {
    context.addIssue({ code: "custom", path: ["httpStatus"], message: "rate limiting must retain HTTP 429" });
  }
  if (error.httpStatus === 402 && error.code !== "ANYSEARCH_QUOTA_EXHAUSTED") {
    context.addIssue({ code: "custom", path: ["code"], message: "HTTP 402 must classify as quota exhaustion" });
  }
  if (error.httpStatus === 429 && error.code !== "ANYSEARCH_RATE_LIMITED") {
    context.addIssue({ code: "custom", path: ["code"], message: "HTTP 429 must classify as rate limiting" });
  }
});

export const LayeredPublicJobDiscoveryTargetSnapshotSchema = z.object({
  targetId: z.uuid(),
  version: positiveInteger,
  priority: z.enum(["primary", "secondary"]),
  state: z.literal("active"),
  constraints: JobTargetConstraintsSchema,
}).strict();

export const LayeredPublicJobDiscoveryProfileSnapshotSchema = z.object({
  targetId: z.uuid(),
  version: positiveInteger,
  confirmedActiveSkillNames: z.array(z.string().trim().min(1).max(100)).max(10).refine(
    (values) => new Set(values).size === values.length,
    { message: "confirmed active skill names must be unique" },
  ),
}).strict();

export const LayeredPublicJobDiscoveryWatchlistSnapshotSchema = z.object({
  targetId: z.uuid(),
  version: nonnegativeInteger,
  companies: z.array(z.object({
    watchlistItemId: z.uuid(),
    canonicalCompanyName: z.string().trim().min(1).max(200),
    allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253).refine(isPublicJobDiscoveryHostname, "must be a registrable public DNS hostname")).min(1).max(20),
  }).strict()).max(50).refine(
    (companies) => new Set(companies.map((company) => company.watchlistItemId)).size === companies.length,
    { message: "watchlist companies must be unique" },
  ),
}).strict();

export const LayeredPublicJobDiscoveryQuerySchema = z.object({
  ordinal: z.int().min(1).max(10),
  queryId: opaqueQueryId,
  kind: PublicJobDiscoveryQueryKindSchema,
  stableFingerprint,
  query: z.string().trim().min(1).max(500),
  allowedSiteDomains: z.array(z.string().trim().toLowerCase().min(1).max(253).refine(isPublicJobDiscoveryHostname, "must be a registrable public DNS hostname")).max(5),
  targetCompanyNames: z.array(z.string().trim().min(1).max(200)).max(5),
  resultLimit: z.literal(5),
}).strict().superRefine((query, context) => {
  if (query.kind === "general" && (query.allowedSiteDomains.length !== 0 || query.targetCompanyNames.length !== 0)) {
    context.addIssue({ code: "custom", message: "general queries have no site or company facts" });
  }
  if (query.kind === "site_constrained" && (query.allowedSiteDomains.length < 1 || query.targetCompanyNames.length !== 0)) {
    context.addIssue({ code: "custom", message: "site-constrained queries require sites only" });
  }
  if (query.kind === "target_company" && query.targetCompanyNames.length < 1) {
    context.addIssue({ code: "custom", message: "target-company queries require company facts" });
  }
});

export const LayeredPublicJobDiscoveryQueryPlanSchema = z.object({
  provider: z.literal("anysearch"),
  queries: z.array(LayeredPublicJobDiscoveryQuerySchema).max(10).refine(
    (queries) => new Set(queries.map((query) => query.queryId)).size === queries.length,
    { message: "query IDs must be unique" },
  ).refine(
    (queries) => new Set(queries.map((query) => query.stableFingerprint)).size === queries.length,
    { message: "query stable fingerprints must be unique" },
  ),
  batchSize: z.literal(5),
  maxVerificationCandidates: nonnegativeInteger.max(10),
}).strict().superRefine((plan, context) => {
  if (plan.queries.some((query, index) => query.ordinal !== index + 1)) {
    context.addIssue({ code: "custom", path: ["queries"], message: "queries must have contiguous deterministic ordinals" });
  }
});

export const LayeredPublicJobDiscoveryQueryAuditSchema = z.object({
  queryId: opaqueQueryId,
  kind: PublicJobDiscoveryQueryKindSchema,
  stableFingerprint,
  leadCount: nonnegativeInteger.max(5),
  verificationCandidateCount: nonnegativeInteger.max(10),
}).strict();

export const GreenhouseTrustedSourceDocumentSchema = z.object({
  kind: z.literal("greenhouse_trusted_source"),
  source: GreenhousePublicSourceSchema,
}).strict();

const AnySearchLeadFacts = {
  leadId: z.uuid(),
  ownerId: z.uuid(),
  runId: z.uuid(),
  targetId: z.uuid(),
  provider: z.literal("anysearch"),
  normalizedUrl: SafeNormalizedPublicJobUrlSchema,
  stableFingerprint,
  queryId: opaqueQueryId,
  queryKind: PublicJobDiscoveryQueryKindSchema,
  queryFingerprint: stableFingerprint,
  expiresAt: z.iso.datetime(),
};
export const AnySearchLeadSchema = z.discriminatedUnion("state", [
  z.object({
    ...AnySearchLeadFacts,
    state: z.literal("pending"),
    sourcePostingVersionId: z.null(),
    rejectionCode: z.null(),
  }).strict(),
  z.object({
    ...AnySearchLeadFacts,
    state: z.literal("verified"),
    sourcePostingVersionId: z.uuid(),
    rejectionCode: z.null(),
  }).strict(),
  z.object({
    ...AnySearchLeadFacts,
    state: z.literal("rejected"),
    sourcePostingVersionId: z.null(),
    rejectionCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
  }).strict(),
]);

export const DiscoveryAttributionSchema = z.object({
  attributionId: z.uuid(),
  ownerId: z.uuid(),
  runId: z.uuid(),
  leadId: z.uuid(),
  queryId: opaqueQueryId,
  provider: z.literal("anysearch"),
  sourcePostingVersionId: z.uuid(),
}).strict();

const PhysicalDiscoveryOperationFacts = {
  operationId: z.uuid(),
  ordinal: positiveInteger.max(60),
  attemptCount: z.int().min(1).max(3),
  reservedToolCalls: z.literal(1),
  status: z.enum(["reserved", "completed", "failed", "cancelled"]),
};
export const PhysicalDiscoveryOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...PhysicalDiscoveryOperationFacts,
    kind: z.literal("search"),
    queryId: opaqueQueryId,
    resultCount: nonnegativeInteger.max(5),
  }).strict(),
  z.object({
    ...PhysicalDiscoveryOperationFacts,
    kind: z.literal("extract"),
    leadId: z.uuid(),
    resultCount: z.literal(0),
  }).strict(),
  z.object({
    ...PhysicalDiscoveryOperationFacts,
    kind: z.literal("fetch"),
    leadId: z.uuid(),
    resultCount: z.literal(0),
  }).strict(),
]);

export const LayeredPublicJobDiscoverySourceScopeSchema = z.object({
  kind: z.literal("layered_public"),
  trustedSources: z.array(GreenhouseTrustedSourceDocumentSchema).max(50).refine(
    (sources) => new Set(sources.map(({ source }) => source.sourceId)).size === sources.length,
    { message: "trusted source IDs must be unique" },
  ),
  publicDiscovery: LayeredPublicJobDiscoveryQueryPlanSchema,
}).strict();

export const DiscoveryDiagnosticSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("provider"), diagnosticId: z.uuid(), runId: z.uuid(), provider: z.literal("anysearch"), code: AnySearchProviderErrorCodeSchema, retryable: z.boolean(), affectedCount: nonnegativeInteger.max(10) }).strict(),
  z.object({ scope: z.literal("query"), diagnosticId: z.uuid(), runId: z.uuid(), queryId: opaqueQueryId, kind: PublicJobDiscoveryQueryKindSchema, stableFingerprint, code: stableCode, retryable: z.boolean(), affectedCount: nonnegativeInteger.max(5) }).strict(),
  z.object({ scope: z.literal("lead"), diagnosticId: z.uuid(), runId: z.uuid(), leadId: z.uuid(), code: stableCode, retryable: z.boolean(), affectedCount: z.literal(1) }).strict(),
]);

const GenericDiscoverySourceIssueSummarySchema = z.object({
  provider: z.enum(["greenhouse", "anysearch"]),
  code: stableCode.refine((code) => !["SOURCE_CAPABILITY_UNSUPPORTED", "SOURCE_CAPABILITY_DECLARATION_MISMATCH"].includes(code)),
  affectedCount: nonnegativeInteger.max(10),
}).strict();

const CapabilityDiscoverySourceIssueSummarySchema = z.object({
  provider: z.literal("greenhouse"),
  code: z.enum(["SOURCE_CAPABILITY_UNSUPPORTED", "SOURCE_CAPABILITY_DECLARATION_MISMATCH"]),
  affectedCount: z.int().min(1).max(10),
  impact: SourceCapabilityImpactSchema,
  retryable: z.literal(false),
  suggestedActions: z.tuple([SourceCapabilitySuggestedActionSchema]),
}).strict();

export const DiscoverySourceIssueSummarySchema = z.union([
  GenericDiscoverySourceIssueSummarySchema,
  CapabilityDiscoverySourceIssueSummarySchema,
]);

export const LayeredPublicJobDiscoveryResultSummarySchema = z.object({
  resultId: z.uuid(),
  sourcePostingVersionId: z.uuid(),
  sourceType: PublicJobDiscoverySourceTypeSchema,
  isOfficial: z.boolean(),
}).strict();

export type LayeredPublicJobDiscoverySourceScope = z.infer<typeof LayeredPublicJobDiscoverySourceScopeSchema>;
export type DiscoveryDiagnostic = z.infer<typeof DiscoveryDiagnosticSchema>;
export type AnySearchLead = z.infer<typeof AnySearchLeadSchema>;
export type AnySearchProviderError = z.infer<typeof AnySearchProviderErrorSchema>;
export type DiscoveryAttribution = z.infer<typeof DiscoveryAttributionSchema>;
export type PhysicalDiscoveryOperation = z.infer<typeof PhysicalDiscoveryOperationSchema>;
export type LayeredPublicJobDiscoveryQueryAudit = z.infer<typeof LayeredPublicJobDiscoveryQueryAuditSchema>;
export type LayeredPublicJobDiscoveryResultSummary = z.infer<typeof LayeredPublicJobDiscoveryResultSummarySchema>;
