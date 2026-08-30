import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  jobDiscoveryLeads,
  jobSourcePostingVersions,
  jobSourcePostings,
  type Database,
} from "@job-copilot/database";
import {
  PublicJobDiscoveryQueryKindSchema,
  PublicJobDiscoverySourceTypeSchema,
  PUBLIC_JOB_SOURCE_TAXONOMY_POLICY_VERSION,
  SafeNormalizedPublicJobUrlSchema,
  isOfficialPublicJobAtsHost,
} from "@job-copilot/contracts/job-discovery";
import { JOB_PAGE_MAX_BYTES } from "@job-copilot/source-access";
import { z } from "zod";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createJobDiscoveryLeadTransitions } from "./job-discovery-lead-transitions";

const TAXONOMY_POLICY = PUBLIC_JOB_SOURCE_TAXONOMY_POLICY_VERSION;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const terminalRejectionCode = z.enum([
  "JOB_PAGE_URL_INVALID", "JOB_PAGE_TARGET_REJECTED", "JOB_PAGE_REDIRECT_INVALID",
  "JOB_PAGE_LOGIN_REQUIRED", "JOB_PAGE_LISTING", "JOB_PAGE_EXPIRED", "JOB_PAGE_UNRECOGNIZED",
  "JOB_PAGE_RESPONSE_TOO_LARGE", "JOB_PAGE_CONTENT_TYPE_INVALID", "POLICY_REJECTED",
]);

const CandidateSchema = z.object({
  queryId: z.uuid(), normalizedUrl: SafeNormalizedPublicJobUrlSchema, candidateFingerprint: fingerprint,
}).strict();
const PageSchema = z.object({
  requestedUrl: SafeNormalizedPublicJobUrlSchema,
  finalUrl: SafeNormalizedPublicJobUrlSchema,
  canonicalUrl: SafeNormalizedPublicJobUrlSchema,
  rawHtml: z.string(), visibleText: z.string(), pageClassification: z.literal("job"),
  sourceKind: z.enum(["official", "aggregator"]),
}).strict();
const VerifyInputSchema = z.object({
  userId: z.uuid(), leadId: z.uuid(), candidate: CandidateSchema,
  extract: z.object({ normalizedUrl: SafeNormalizedPublicJobUrlSchema }).strict(),
  page: PageSchema, now: z.date(),
}).strict();
const RejectInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid(), code: terminalRejectionCode, now: z.date() }).strict();

export interface VerifiedJobEvidenceStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/html" | "text/plain" }): Promise<{ created: boolean }>;
  delete(input: { objectKey: string }): Promise<void>;
}

export class VerifiedJobEvidenceStoreUnavailableError extends Error {}

export class VerifiedJobSourceGateError extends Error {
  constructor(public readonly code:
    | "VERIFIED_JOB_SOURCE_INVALID_INPUT"
    | "VERIFIED_JOB_SOURCE_LEAD_NOT_FOUND"
    | "VERIFIED_JOB_SOURCE_LEAD_CONFLICT"
    | "VERIFIED_JOB_SOURCE_STORAGE_FAILED"
    | "VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED"
    | "VERIFIED_JOB_SOURCE_PERSIST_FAILED"
    | "VERIFIED_JOB_SOURCE_RETRYABLE_FAILURE") {
    super(code);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function sameOrigin(left: string, right: string): boolean { return new URL(left).origin === new URL(right).origin; }
function validatePage(value: z.infer<typeof VerifyInputSchema>): void {
  const candidateFingerprint = sha256(value.candidate.normalizedUrl);
  const rawBytes = bytes(value.page.rawHtml);
  const visibleBytes = bytes(value.page.visibleText);
  if (candidateFingerprint !== value.candidate.candidateFingerprint
    || value.extract.normalizedUrl !== value.candidate.normalizedUrl
    || value.page.requestedUrl !== value.candidate.normalizedUrl
    || !sameOrigin(value.page.requestedUrl, value.page.finalUrl)
    || !sameOrigin(value.page.finalUrl, value.page.canonicalUrl)
    || rawBytes.byteLength === 0 || visibleBytes.byteLength === 0
    || rawBytes.byteLength > JOB_PAGE_MAX_BYTES || visibleBytes.byteLength > JOB_PAGE_MAX_BYTES) {
    throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_INVALID_INPUT");
  }
}

function hostMatches(host: string, domain: string): boolean { return host === domain || host.endsWith(`.${domain}`); }
function sourceType(page: z.infer<typeof PageSchema>, queryKind: z.infer<typeof PublicJobDiscoveryQueryKindSchema>) {
  const host = new URL(page.canonicalUrl).hostname;
  if (["zhipin.com", "liepin.com", "zhaopin.com"].some((domain) => hostMatches(host, domain))) return "recruitment_platform" as const;
  if (hostMatches(host, "mp.weixin.qq.com")) return "wechat_recruitment_h5" as const;
  if (isOfficialPublicJobAtsHost(host)) return "company_careers" as const;
  return queryKind === "target_company" ? "company_careers" as const : "public_web" as const;
}

function parseVerifyInput(input: unknown) {
  const parsed = VerifyInputSchema.safeParse(input);
  if (!parsed.success) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_INVALID_INPUT");
  validatePage(parsed.data);
  return parsed.data;
}

function evidenceObjectKeys(userId: string, sourceVersionId: string, rawHash: string, visibleHash: string) {
  const base = `accounts/${userId}/public-job-pages/${sourceVersionId}`;
  return { rawHtmlObjectKey: `${base}/${rawHash}.html`, visibleTextObjectKey: `${base}/${visibleHash}.txt` };
}
function deterministicSourceVersionId(input: { userId: string; leadId: string; sourceType: string; canonicalUrl: string; rawHash: string; visibleHash: string }): string {
  const value = createHash("sha256").update([
    "public-job-source-generation-v1", input.userId, input.leadId, input.sourceType, input.canonicalUrl, input.rawHash, input.visibleHash,
  ].join("\u001f"), "utf8").digest();
  value[6] = (value[6]! & 0x0f) | 0x80;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right)); }

export function createVerifiedJobSourceGate(deps: { db: Database; contentStore: VerifiedJobEvidenceStore; id: () => string }) {
  const transitions = createJobDiscoveryLeadTransitions({ db: deps.db, id: deps.id });

  async function cleanupUnreferencedObjects(transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], userId: string, objectKeys: readonly string[]) {
    const versions = await transaction.select({ rawObjectReference: jobSourcePostingVersions.rawObjectReference }).from(jobSourcePostingVersions)
      .where(eq(jobSourcePostingVersions.userId, userId));
    const referenced = new Set(versions.flatMap(({ rawObjectReference }) => {
      if (!rawObjectReference || typeof rawObjectReference !== "object" || Array.isArray(rawObjectReference)) return [];
      return Object.values(rawObjectReference).filter((value): value is string => typeof value === "string");
    }));
    for (const objectKey of objectKeys) {
      if (!referenced.has(objectKey)) {
        try { await deps.contentStore.delete({ objectKey }); }
        catch (error) {
          if (error instanceof VerifiedJobEvidenceStoreUnavailableError) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED");
          throw error;
        }
      }
    }
  }

  async function cleanupCreatedObjects(userId: string, objectKeys: readonly string[]) {
    if (objectKeys.length === 0) return;
    await deps.db.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, userId);
      await cleanupUnreferencedObjects(transaction, userId, objectKeys);
    });
  }

  return {
    async verify(input: unknown) {
      const value = parseVerifyInput(input);
      const rawBytes = bytes(value.page.rawHtml);
      const visibleBytes = bytes(value.page.visibleText);
      const rawContentSha256 = sha256(rawBytes);
      const contentSha256 = sha256(visibleBytes);
      const sourceIdentifier = sha256(value.page.canonicalUrl);
      const createdObjectKeys: string[] = [];
      try {
        return await deps.db.transaction(async (transaction) => {
          await acquireAccountAdvisoryLock(transaction, value.userId);
          const [lead] = await transaction.select().from(jobDiscoveryLeads).where(and(
            eq(jobDiscoveryLeads.userId, value.userId), eq(jobDiscoveryLeads.id, value.leadId),
          )).limit(1);
          if (!lead) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_NOT_FOUND");
          if (lead.queryId !== value.candidate.queryId || lead.normalizedUrl !== value.candidate.normalizedUrl
            || lead.stableFingerprint !== value.candidate.candidateFingerprint) {
            throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_CONFLICT");
          }
          const expectedSourceType = sourceType(value.page, lead.queryKind as z.infer<typeof PublicJobDiscoveryQueryKindSchema>);
          const expectedSourceIdentity = { taxonomyPolicy: TAXONOMY_POLICY, canonicalUrl: value.page.canonicalUrl, finalUrl: value.page.finalUrl };
          const expectedOfficial = value.page.sourceKind === "official";
          const sourceVersionId = deterministicSourceVersionId({
            userId: value.userId, leadId: value.leadId, sourceType: expectedSourceType, canonicalUrl: value.page.canonicalUrl,
            rawHash: rawContentSha256, visibleHash: contentSha256,
          });
          const objectKeys = evidenceObjectKeys(value.userId, sourceVersionId, rawContentSha256, contentSha256);
          let posting: { id: string; sourceType: string; sourceIdentifier: string; sourceId: string | null; sourceIdentity: unknown; isOfficial: boolean };
          const [foundPosting] = await transaction.select({
            id: jobSourcePostings.id, sourceType: jobSourcePostings.sourceType, sourceIdentifier: jobSourcePostings.sourceIdentifier,
            sourceId: jobSourcePostings.sourceId, sourceIdentity: jobSourcePostings.sourceIdentity, isOfficial: jobSourcePostings.isOfficial,
          }).from(jobSourcePostings).where(and(
            eq(jobSourcePostings.userId, value.userId), eq(jobSourcePostings.sourceType, expectedSourceType), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier),
          )).limit(1);
          if (foundPosting) {
            if (foundPosting.sourceId !== value.page.canonicalUrl || !sameJson(foundPosting.sourceIdentity, expectedSourceIdentity) || foundPosting.isOfficial !== expectedOfficial) {
              throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_CONFLICT");
            }
            posting = foundPosting;
          } else {
            const [createdPosting] = await transaction.insert(jobSourcePostings).values({
              id: deps.id(), userId: value.userId, sourceType: PublicJobDiscoverySourceTypeSchema.parse(expectedSourceType), sourceIdentifier,
              sourceId: value.page.canonicalUrl, sourceIdentity: expectedSourceIdentity, isOfficial: expectedOfficial, createdAt: value.now, updatedAt: value.now,
            }).returning({ id: jobSourcePostings.id, sourceType: jobSourcePostings.sourceType, sourceIdentifier: jobSourcePostings.sourceIdentifier, sourceId: jobSourcePostings.sourceId, sourceIdentity: jobSourcePostings.sourceIdentity, isOfficial: jobSourcePostings.isOfficial });
            if (!createdPosting) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_PERSIST_FAILED");
            posting = createdPosting;
          }
          const [existingVersion] = await transaction.select({
            id: jobSourcePostingVersions.id, sourcePostingId: jobSourcePostingVersions.sourcePostingId,
            version: jobSourcePostingVersions.version, contentSha256: jobSourcePostingVersions.contentSha256,
            rawContentSha256: jobSourcePostingVersions.rawContentSha256, rawObjectReference: jobSourcePostingVersions.rawObjectReference,
            normalizedData: jobSourcePostingVersions.normalizedData,
            createdAt: jobSourcePostingVersions.createdAt,
          }).from(jobSourcePostingVersions).innerJoin(jobSourcePostings, and(
            eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId),
          )).where(and(
            eq(jobSourcePostingVersions.userId, value.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id),
            eq(jobSourcePostingVersions.contentSha256, contentSha256), eq(jobSourcePostingVersions.rawContentSha256, rawContentSha256),
          )).limit(1);
          if (existingVersion && (!sameJson(existingVersion.rawObjectReference, evidenceObjectKeys(value.userId, existingVersion.id, rawContentSha256, contentSha256))
            || !sameJson(existingVersion.normalizedData, {}))) {
            throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_CONFLICT");
          }
          if (existingVersion && existingVersion.id !== sourceVersionId) await cleanupUnreferencedObjects(transaction, value.userId, Object.values(objectKeys));
          if (lead.state === "verified" && lead.sourcePostingVersionId !== existingVersion?.id) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_CONFLICT");
          if (lead.state === "rejected") throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_LEAD_CONFLICT");

          let version = existingVersion;
          if (!version) {
            let rawPut: { created: boolean };
            let visiblePut: { created: boolean };
            try { rawPut = await deps.contentStore.put({ objectKey: objectKeys.rawHtmlObjectKey, bytes: rawBytes, mediaType: "text/html" }); }
            catch (error) {
              if (error instanceof VerifiedJobEvidenceStoreUnavailableError) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_STORAGE_FAILED");
              throw error;
            }
            if (rawPut.created) createdObjectKeys.push(objectKeys.rawHtmlObjectKey);
            try { visiblePut = await deps.contentStore.put({ objectKey: objectKeys.visibleTextObjectKey, bytes: visibleBytes, mediaType: "text/plain" }); }
            catch (error) {
              if (error instanceof VerifiedJobEvidenceStoreUnavailableError) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_STORAGE_FAILED");
              throw error;
            }
            if (visiblePut.created) createdObjectKeys.push(objectKeys.visibleTextObjectKey);
            const [latest] = await transaction.select({ version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions).where(and(
              eq(jobSourcePostingVersions.userId, value.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id),
            )).orderBy(desc(jobSourcePostingVersions.version)).limit(1);
            const [createdVersion] = await transaction.insert(jobSourcePostingVersions).values({
              id: sourceVersionId, userId: value.userId, sourcePostingId: posting.id, version: (latest?.version ?? 0) + 1,
              contentSha256, rawContentSha256, rawObjectReference: objectKeys, normalizedData: {}, retrievedAt: value.now, createdAt: value.now,
            }).returning({ id: jobSourcePostingVersions.id, sourcePostingId: jobSourcePostingVersions.sourcePostingId, version: jobSourcePostingVersions.version, contentSha256: jobSourcePostingVersions.contentSha256, rawContentSha256: jobSourcePostingVersions.rawContentSha256, rawObjectReference: jobSourcePostingVersions.rawObjectReference, normalizedData: jobSourcePostingVersions.normalizedData, createdAt: jobSourcePostingVersions.createdAt });
            if (!createdVersion) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_PERSIST_FAILED");
            version = createdVersion;
          }
          const verified = await transitions.verifyAndAttributeInTransaction({ userId: value.userId, leadId: value.leadId, sourcePostingVersionId: version.id, now: value.now }, transaction);
          return {
            ...verified,
            sourcePosting: { postingId: posting.id, sourceType: posting.sourceType, sourceIdentifier: posting.sourceIdentifier, sourceId: posting.sourceId, sourceIdentity: posting.sourceIdentity, isOfficial: posting.isOfficial },
            sourcePostingVersion: { sourcePostingVersionId: version.id, version: version.version, contentSha256: version.contentSha256, rawContentSha256: version.rawContentSha256, rawObjectReference: version.rawObjectReference },
          };
        });
      } catch (error) {
        await cleanupCreatedObjects(value.userId, createdObjectKeys);
        throw error;
      }
    },

    async reject(input: unknown) {
      const parsed = RejectInputSchema.safeParse(input);
      if (!parsed.success) {
        const retryable = z.object({
          userId: z.uuid(), leadId: z.uuid(),
          code: z.enum(["JOB_PAGE_TIMEOUT", "JOB_PAGE_CANCELLED", "JOB_PAGE_UNREACHABLE", "JOB_PAGE_RATE_LIMITED"]), now: z.date(),
        }).strict().safeParse(input);
        if (retryable.success) throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_RETRYABLE_FAILURE");
        throw new VerifiedJobSourceGateError("VERIFIED_JOB_SOURCE_INVALID_INPUT");
      }
      return transitions.reject({
        userId: parsed.data.userId, leadId: parsed.data.leadId, rejectionCode: parsed.data.code, now: parsed.data.now,
      });
    },
  };
}
