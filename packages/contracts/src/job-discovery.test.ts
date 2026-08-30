import { describe, expect, it } from "vitest";
import {
  AnySearchLeadSchema,
  AnySearchProviderErrorSchema,
  DiscoveryAttributionSchema,
  DiscoveryDiagnosticSchema,
  LayeredPublicJobDiscoveryQueryAuditSchema,
  LayeredPublicJobDiscoveryQueryPlanSchema,
  LayeredPublicJobDiscoveryResultSummarySchema,
  PhysicalDiscoveryOperationSchema,
} from "./job-discovery";

describe("AnySearch job discovery contracts", () => {
  it("keeps an AnySearch lead unverified and outside trusted-source documents", () => {
    const lead = {
      leadId: "f1a56b94-838d-4a68-856f-2b943a61a289",
      ownerId: "ec09ab6f-af8f-4b78-9a9c-cbcfbb1e5799",
      runId: "1e764df5-19f3-49f3-b16e-512147298baa",
      targetId: "87a0d3ac-4aed-4bd5-a703-68bf82cc6c49",
      provider: "anysearch",
      normalizedUrl: "https://careers.example.com/jobs/123",
      stableFingerprint: "b".repeat(64),
      queryId: "general-ai-engineer",
      queryFingerprint: "a".repeat(64),
      expiresAt: "2026-09-29T00:00:00.000Z",
      state: "pending",
      sourcePostingVersionId: null,
      rejectionCode: null,
    };

    expect(AnySearchLeadSchema.parse(lead)).toEqual(lead);
    expect(AnySearchLeadSchema.safeParse({ ...lead, title: "AI 工程师" }).success).toBe(false);
    expect(AnySearchLeadSchema.safeParse({ ...lead, normalizedUrl: "https://careers.example.com/jobs/123#section" }).success).toBe(false);
    expect(AnySearchLeadSchema.safeParse({ ...lead, kind: "greenhouse_trusted_source" }).success).toBe(false);
  });

  it("redacts provider diagnostics while binding attribution to a verified source version", () => {
    const providerError = {
      code: "ANYSEARCH_RATE_LIMITED",
      retryable: true,
      httpStatus: 429,
    };
    const attribution = {
      attributionId: "848ba247-4e5a-4748-8431-fdbc12dd7e59",
      ownerId: "ec09ab6f-af8f-4b78-9a9c-cbcfbb1e5799",
      runId: "1e764df5-19f3-49f3-b16e-512147298baa",
      leadId: "f1a56b94-838d-4a68-856f-2b943a61a289",
      queryId: "general-ai-engineer",
      provider: "anysearch",
      sourcePostingVersionId: "04c82662-336c-4b5a-9de5-5b9785ba2c0f",
    };
    const diagnostic = {
      scope: "query",
      diagnosticId: "1d300e98-1979-4c5c-8789-9a9055622a2a",
      runId: "1e764df5-19f3-49f3-b16e-512147298baa",
      queryId: "general-ai-engineer",
      kind: "general",
      stableFingerprint: "a".repeat(64),
      code: "ANYSEARCH_RATE_LIMITED",
      retryable: true,
      affectedCount: 5,
    };

    expect(AnySearchProviderErrorSchema.parse(providerError)).toEqual(providerError);
    expect(DiscoveryAttributionSchema.parse(attribution)).toEqual(attribution);
    expect(DiscoveryDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(AnySearchProviderErrorSchema.safeParse({ ...providerError, message: "quota exceeded" }).success).toBe(false);
    expect(DiscoveryAttributionSchema.safeParse({ ...attribution, sourceId: "anysearch:lead" }).success).toBe(false);
    expect(DiscoveryDiagnosticSchema.safeParse({ ...diagnostic, rawQuery: "AI 工程师 上海" }).success).toBe(false);
    expect(DiscoveryDiagnosticSchema.safeParse({ ...diagnostic, code: "provider said quota exceeded" }).success).toBe(false);
  });

  it("records each provider search, extract, and fetch as its own bounded physical operation", () => {
    const operation = {
      operationId: "ac2aa6e7-3da6-4a0f-888c-657d2cccae34",
      ordinal: 1,
      kind: "search",
      queryId: "general-ai-engineer",
      attemptCount: 1,
      reservedToolCalls: 1,
      resultCount: 5,
      status: "completed",
    };

    expect(PhysicalDiscoveryOperationSchema.parse(operation)).toEqual(operation);
    expect(PhysicalDiscoveryOperationSchema.safeParse({ ...operation, reservedToolCalls: 5 }).success).toBe(false);
    expect(PhysicalDiscoveryOperationSchema.safeParse({ ...operation, attemptCount: 4 }).success).toBe(false);
    expect(PhysicalDiscoveryOperationSchema.safeParse({ ...operation, clientBatchId: "one-batch" }).success).toBe(false);
  });

  it("projects redacted query audit facts and verified source result summaries", () => {
    const audit = {
      queryId: "general-ai-engineer",
      kind: "general",
      stableFingerprint: "a".repeat(64),
      leadCount: 5,
      verificationCandidateCount: 5,
    };
    const result = {
      resultId: "a42bc9e8-5b65-4089-b6dc-a5f17d1d5b80",
      sourcePostingVersionId: "04c82662-336c-4b5a-9de5-5b9785ba2c0f",
      sourceType: "recruitment_platform",
      isOfficial: false,
    };

    expect(LayeredPublicJobDiscoveryQueryAuditSchema.parse(audit)).toEqual(audit);
    expect(LayeredPublicJobDiscoveryResultSummarySchema.parse(result)).toEqual(result);
    expect(LayeredPublicJobDiscoveryQueryAuditSchema.safeParse({ ...audit, query: "AI 工程师 上海" }).success).toBe(false);
    expect(LayeredPublicJobDiscoveryResultSummarySchema.safeParse({ ...result, sourceType: "anysearch" }).success).toBe(false);
  });

  it("requires an ordered bounded query plan without exposing raw queries in its audit", () => {
    const queryPlan = {
      provider: "anysearch",
      queries: [{
        ordinal: 1,
        queryId: "general-ai-engineer",
        kind: "general",
        stableFingerprint: "a".repeat(64),
        query: "AI 工程师 上海",
        allowedSiteDomains: [],
        targetCompanyNames: [],
        resultLimit: 5,
      }],
      batchSize: 5,
      maxVerificationCandidates: 10,
    };

    expect(LayeredPublicJobDiscoveryQueryPlanSchema.parse(queryPlan)).toEqual(queryPlan);
    expect(LayeredPublicJobDiscoveryQueryPlanSchema.safeParse({ ...queryPlan, queries: [{ ...queryPlan.queries[0], ordinal: 2 }] }).success).toBe(false);
  });
});
