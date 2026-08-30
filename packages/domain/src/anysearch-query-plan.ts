import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LayeredPublicJobDiscoveryProfileSnapshotSchema,
  LayeredPublicJobDiscoveryQueryAuditSchema,
  LayeredPublicJobDiscoveryQueryPlanSchema,
  LayeredPublicJobDiscoveryQuerySchema,
  LayeredPublicJobDiscoveryTargetSnapshotSchema,
  LayeredPublicJobDiscoveryWatchlistSnapshotSchema,
} from "@job-copilot/contracts/job-discovery";

export const ANYSEARCH_PUBLIC_JOB_QUERY_POLICY_VERSION = "anysearch-public-job-query-policy-v1";
const MAX_QUERY_LENGTH = 500;
export const ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY = Object.freeze({
  version: ANYSEARCH_PUBLIC_JOB_QUERY_POLICY_VERSION,
  platforms: Object.freeze([
    Object.freeze({ platform: "boss", allowedSiteDomains: Object.freeze(["zhipin.com"]) }),
    Object.freeze({ platform: "liepin", allowedSiteDomains: Object.freeze(["liepin.com"]) }),
    Object.freeze({ platform: "zhaopin", allowedSiteDomains: Object.freeze(["zhaopin.com"]) }),
    Object.freeze({ platform: "wechat_h5", allowedSiteDomains: Object.freeze(["mp.weixin.qq.com"]) }),
  ]),
});

const QueryPlannerInputSchema = z.object({
  targetSnapshot: LayeredPublicJobDiscoveryTargetSnapshotSchema,
  profileSnapshot: LayeredPublicJobDiscoveryProfileSnapshotSchema,
  watchlistSnapshot: LayeredPublicJobDiscoveryWatchlistSnapshotSchema,
}).strict();

const QueryAuditInputSchema = z.object({
  query: LayeredPublicJobDiscoveryQuerySchema,
  leadCount: z.int().nonnegative().max(5),
  verificationCandidateCount: z.int().nonnegative().max(10),
}).strict();

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function deterministicUuidV8(fingerprint: string): string {
  const bytes = fingerprint.slice(0, 32).split("");
  bytes[12] = "8";
  bytes[16] = ((Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);
  const compact = bytes.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function queryText(input: {
  kind: "general" | "site_constrained" | "target_company";
  roleFamily: string;
  seniority: string | null;
  locations: string[];
  workModes: string[];
  skills: string[];
  siteDomains?: string[];
  companyName?: string;
}): string {
  const append = (query: string, terms: Array<string | null | undefined>) => {
    let nextQuery = query;
    for (const term of terms) {
      if (!term) continue;
      const normalized = normalizeWhitespace(term);
      const candidate = `${nextQuery} ${normalized}`;
      if (candidate.length <= MAX_QUERY_LENGTH) nextQuery = candidate;
    }
    return nextQuery;
  };
  let query = input.roleFamily;
  if (input.kind === "site_constrained") query = append(query, input.siteDomains?.map((domain) => `site:${domain}`) ?? []);
  if (input.kind === "target_company") {
    query = append(query, [input.companyName]);
    query = append(query, input.siteDomains?.map((domain) => `site:${domain}`) ?? []);
  }
  return append(query, [
    input.seniority,
    ...input.locations,
    ...input.workModes,
    ...input.skills,
  ]);
}

export function createAnySearchQueryPlan(input: unknown) {
  const snapshots = QueryPlannerInputSchema.parse(input);
  const { targetSnapshot, profileSnapshot, watchlistSnapshot } = snapshots;
  if (targetSnapshot.targetId !== profileSnapshot.targetId || targetSnapshot.targetId !== watchlistSnapshot.targetId) {
    throw new Error("ANYSEARCH_QUERY_PLAN_TARGET_MISMATCH");
  }

  const queryFacts = {
    targetId: targetSnapshot.targetId,
    targetVersion: targetSnapshot.version,
    priority: targetSnapshot.priority,
    roleFamily: normalizeWhitespace(targetSnapshot.constraints.roleFamily),
    seniority: targetSnapshot.constraints.seniority && normalizeWhitespace(targetSnapshot.constraints.seniority),
    locations: targetSnapshot.constraints.locations.map(normalizeWhitespace),
    workModes: [...targetSnapshot.constraints.workModes],
    profileVersion: profileSnapshot.version,
    confirmedActiveSkillNames: profileSnapshot.confirmedActiveSkillNames.map(normalizeWhitespace),
  };
  const createQuery = (kind: "general" | "site_constrained" | "target_company", input: {
    allowedSiteDomains?: readonly string[];
    companyName?: string;
    watchlistItemId?: string;
    watchlistVersion?: number;
  }) => {
    const approvedAllowedSiteDomains = input.allowedSiteDomains ? [...input.allowedSiteDomains] : [];
    const allowedSiteDomains = approvedAllowedSiteDomains.slice(0, 5);
    const companyName = input.companyName && normalizeWhitespace(input.companyName);
    const query = queryText({
      kind,
      roleFamily: queryFacts.roleFamily,
      seniority: queryFacts.seniority,
      locations: queryFacts.locations,
      workModes: queryFacts.workModes,
      skills: queryFacts.confirmedActiveSkillNames,
      siteDomains: allowedSiteDomains,
      companyName,
    });
    const stableFingerprint = sha256({
      policyVersion: ANYSEARCH_PUBLIC_JOB_QUERY_POLICY_VERSION,
      kind,
      queryFacts,
      approvedAllowedSiteDomains,
      allowedSiteDomains,
      companyName: companyName ?? null,
      watchlistItemId: input.watchlistItemId ?? null,
      watchlistVersion: input.watchlistVersion ?? null,
    });
    return {
      queryId: deterministicUuidV8(stableFingerprint),
      kind,
      stableFingerprint,
      query,
      allowedSiteDomains,
      targetCompanyNames: companyName ? [companyName] : [],
      resultLimit: 5 as const,
    };
  };

  const queries = [
    createQuery("general", {}),
    ...ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY.platforms.map(({ allowedSiteDomains }) =>
      createQuery("site_constrained", { allowedSiteDomains })),
    ...watchlistSnapshot.companies.slice(0, 5).map((company) => createQuery("target_company", {
      allowedSiteDomains: company.allowedDomains,
      companyName: company.canonicalCompanyName,
      watchlistItemId: company.watchlistItemId,
      watchlistVersion: watchlistSnapshot.version,
    })),
  ].map((query, index) => ({ ...query, ordinal: index + 1 }));

  return LayeredPublicJobDiscoveryQueryPlanSchema.parse({
    provider: "anysearch",
    queries,
    batchSize: 5,
    maxVerificationCandidates: 10,
  });
}

export function createAnySearchQueryAudit(input: unknown) {
  const audit = QueryAuditInputSchema.parse(input);
  return LayeredPublicJobDiscoveryQueryAuditSchema.parse({
    queryId: audit.query.queryId,
    kind: audit.query.kind,
    stableFingerprint: audit.query.stableFingerprint,
    leadCount: audit.leadCount,
    verificationCandidateCount: audit.verificationCandidateCount,
  });
}
