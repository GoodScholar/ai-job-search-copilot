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

const queryId = "d3b1f38c-36c3-47df-8f40-4e62bb749e7f";

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
      queryId,
      queryKind: "general",
      queryFingerprint: "a".repeat(64),
      expiresAt: "2026-09-29T00:00:00.000Z",
      state: "pending",
      sourcePostingVersionId: null,
      rejectionCode: null,
    };

    expect(AnySearchLeadSchema.parse(lead)).toEqual(lead);
    expect(AnySearchLeadSchema.safeParse({ ...lead, title: "AI 工程师" }).success).toBe(false);
    expect(AnySearchLeadSchema.safeParse({ ...lead, queryKind: "unbounded" }).success).toBe(false);
    expect(AnySearchLeadSchema.safeParse({ ...lead, normalizedUrl: "https://careers.example.com/jobs/123#section" }).success).toBe(false);
    expect(AnySearchLeadSchema.safeParse({ ...lead, kind: "greenhouse_trusted_source" }).success).toBe(false);
    for (const nonOpaqueQueryId of ["Jane Doe", "jane@example.com", "AI 工程师 上海", "session=secret", "utm_source=campaign"]) {
      expect(AnySearchLeadSchema.safeParse({ ...lead, queryId: nonOpaqueQueryId }).success).toBe(false);
    }
    const leadWithPublicJobIdentity = { ...lead, normalizedUrl: "https://careers.example.com/jobs?jobId=123" };
    expect(AnySearchLeadSchema.parse(leadWithPublicJobIdentity)).toEqual(leadWithPublicJobIdentity);
    for (const sensitiveParameter of ["session", "token", "utm_source", "gclid", "fbclid"]) {
      expect(AnySearchLeadSchema.safeParse({ ...lead, normalizedUrl: `https://careers.example.com/jobs?${sensitiveParameter}=secret` }).success).toBe(false);
    }
    for (const encodedSensitiveValue of ["session%3Dsecret", "utm_source%3Dcampaign", "job%26token%3Dsecret"]) {
      expect(AnySearchLeadSchema.safeParse({ ...lead, normalizedUrl: `https://careers.example.com/jobs?jobId=${encodedSensitiveValue}` }).success).toBe(false);
    }
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
      queryId,
      provider: "anysearch",
      sourcePostingVersionId: "04c82662-336c-4b5a-9de5-5b9785ba2c0f",
    };
    const diagnostic = {
      scope: "query",
      diagnosticId: "1d300e98-1979-4c5c-8789-9a9055622a2a",
      runId: "1e764df5-19f3-49f3-b16e-512147298baa",
      queryId,
      kind: "general",
      stableFingerprint: "a".repeat(64),
      code: "ANYSEARCH_RATE_LIMITED",
      retryable: true,
      affectedCount: 5,
    };

    expect(AnySearchProviderErrorSchema.parse(providerError)).toEqual(providerError);
    for (const persistedProviderError of [
      { code: "ANYSEARCH_AUTH_FAILED", retryable: false, httpStatus: 401 },
      { code: "ANYSEARCH_AUTH_FAILED", retryable: false, httpStatus: 403 },
      { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 },
      { code: "ANYSEARCH_TIMEOUT", retryable: true, httpStatus: 504 },
    ]) expect(AnySearchProviderErrorSchema.parse(persistedProviderError)).toEqual(persistedProviderError);
    expect(AnySearchProviderErrorSchema.safeParse({ code: "ANYSEARCH_QUOTA_EXHAUSTED", retryable: false, httpStatus: 429 }).success).toBe(false);
    expect(AnySearchProviderErrorSchema.safeParse({ code: "ANYSEARCH_RATE_LIMITED", retryable: true, httpStatus: 402 }).success).toBe(false);
    expect(AnySearchProviderErrorSchema.safeParse({ code: "ANYSEARCH_TIMEOUT", retryable: true, httpStatus: 402 }).success).toBe(false);
    expect(AnySearchProviderErrorSchema.safeParse({ code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 429 }).success).toBe(false);
    expect(DiscoveryAttributionSchema.parse(attribution)).toEqual(attribution);
    expect(DiscoveryDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(AnySearchProviderErrorSchema.safeParse({ ...providerError, message: "quota exceeded" }).success).toBe(false);
    expect(DiscoveryAttributionSchema.safeParse({ ...attribution, sourceId: "anysearch:lead" }).success).toBe(false);
    expect(DiscoveryDiagnosticSchema.safeParse({ ...diagnostic, rawQuery: "AI 工程师 上海" }).success).toBe(false);
    expect(DiscoveryDiagnosticSchema.safeParse({ ...diagnostic, code: "provider said quota exceeded" }).success).toBe(false);
    const providerDiagnostic = {
      scope: "provider",
      diagnosticId: "1d300e98-1979-4c5c-8789-9a9055622a2a",
      runId: "1e764df5-19f3-49f3-b16e-512147298baa",
      provider: "anysearch",
      code: "ANYSEARCH_TIMEOUT",
      retryable: true,
      affectedCount: 1,
    };
    expect(DiscoveryDiagnosticSchema.parse(providerDiagnostic)).toEqual(providerDiagnostic);
    expect(DiscoveryDiagnosticSchema.safeParse({ ...providerDiagnostic, code: "UNKNOWN_PROVIDER_CODE" }).success).toBe(false);
  });

  it("records each provider search, extract, and fetch as its own bounded physical operation", () => {
    const operation = {
      operationId: "ac2aa6e7-3da6-4a0f-888c-657d2cccae34",
      ordinal: 1,
      kind: "search",
      queryId,
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
      queryId,
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
        queryId,
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
    expect(LayeredPublicJobDiscoveryQueryPlanSchema.safeParse({ ...queryPlan, queries: [] }).success).toBe(false);
    expect(LayeredPublicJobDiscoveryQueryPlanSchema.safeParse({
      ...queryPlan,
      queries: [
        queryPlan.queries[0],
        { ...queryPlan.queries[0], ordinal: 2, queryId: "e406955b-597c-4a2f-9d1d-301f807d7c26" },
      ],
    }).success).toBe(false);
  });
});
