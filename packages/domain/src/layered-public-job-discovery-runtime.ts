import { createHash } from "node:crypto";
import type { Database } from "@job-copilot/database";
import { GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION } from "@job-copilot/contracts/agent-runs";
import type { RecommendationDiscoveryFacts } from "@job-copilot/contracts/recommendation-discovery-facts";

import type { AuditTrail } from "./audit-trail";
import { canonicalJsonBytes, type DiscoveryContentStore } from "./agent-run-processor";
import { createJobDiscoveryPersistence, type DiscoveryDetail, type StoredDiscoveryObject } from "./job-discovery-persistence";
import { createJobDiscoveryLeadRepository } from "./job-discovery-leads";
import { createLayeredPublicJobDiscoveryWorkflow, type LayeredPublicJobDiscoveryWorkflow } from "./layered-public-job-discovery-workflow";
import { createVerifiedJobSourceGate, type VerifiedJobEvidenceStore } from "./verified-job-source-gate";
import { authorizeSourceAction, type SourceCapabilityAdapter } from "./source-capabilities";

type WorkflowDependencies = Parameters<typeof createLayeredPublicJobDiscoveryWorkflow>[0];
type LayeredSpec = Parameters<LayeredPublicJobDiscoveryWorkflow["run"]>[0]["executionSpec"];
type TrustedSource = Extract<LayeredSpec["sourceScope"]["trustedSources"][number], { kind: "greenhouse_trusted_source" }>["source"];

export interface LayeredTrustedSourceAdapter extends SourceCapabilityAdapter {
  listSource(input: { targetSnapshot: LayeredSpec["targetSnapshot"]; source: TrustedSource; signal: AbortSignal }): Promise<
    | { ok: true; data: { sourceId: string; observedDetailIds: string[]; candidates: Array<{ sourceId: string; detailId: string }> } }
    | { ok: false; error: { code: string } }
  >;
  getSourceDetail(input: { source: TrustedSource; detailId: string; signal: AbortSignal }): Promise<
    | { ok: true; data: DiscoveryDetail }
    | { ok: false; error: { code: string } }
  >;
}

function sourceIssueCode(value: string, fallback: string) {
  return /^GREENHOUSE_[A-Z0-9_]{1,100}$/u.test(value) || value === "SOURCE_CAPABILITY_UNSUPPORTED" ? value : fallback;
}

function rawObject(input: { id: () => string; userId: string; runId: string; sourceId: string; detail: DiscoveryDetail }): StoredDiscoveryObject {
  const bytes = canonicalJsonBytes(input.detail.rawPayload);
  const sourceHash = createHash("sha256").update(`${input.sourceId}:${input.detail.detailId}`).digest("hex");
  return {
    sourceId: input.sourceId,
    detailId: input.detail.detailId,
    objectKey: `accounts/${input.userId}/agent-runs/${input.runId}/trusted/${sourceHash}-${input.id()}.json`,
    rawContentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function cleanup(store: DiscoveryContentStore, objectKeys: readonly string[]) {
  await Promise.all(objectKeys.map(async (objectKey) => { try { await store.delete({ objectKey }); } catch { /* 补偿不得掩盖 claim 或 provider 结果。 */ } }));
}

/**
 * v4 运行时唯一持有 claim-bound Lead/Gate 的组装点；Worker 只能提供外部 I/O ports。
 */
export function createLayeredPublicJobDiscoveryRuntime(input: Omit<WorkflowDependencies, "leads" | "gate" | "trustedSources"> & {
  db: Database;
  id: () => string;
  auditTrail: AuditTrail;
  contentStore: DiscoveryContentStore;
  evidenceStore: VerifiedJobEvidenceStore;
  trustedSourceAdapter: LayeredTrustedSourceAdapter;
  afterVerifiedPersistence?: (input: { normalizedUrl: string }) => Promise<void>;
}) {
  const leads = createJobDiscoveryLeadRepository({ db: input.db, id: input.id });
  const gate = createVerifiedJobSourceGate({ db: input.db, contentStore: input.evidenceStore, id: input.id });
  const persistence = createJobDiscoveryPersistence({ db: input.db, id: input.id, auditTrail: input.auditTrail });
  const trustedSources: WorkflowDependencies["trustedSources"] = {
    discover: async ({ userId, runId, claimToken, now, executionSpec, signal, beforeRequest }) => {
      const frozenSources = executionSpec.sourceScope.trustedSources;
      if (frozenSources.length === 0) return { succeeded: false, verifiedSourcePostingVersionIds: [], discoveryFacts: [] };
      const sourceIssues: Array<{ code: string; affectedCount: number }> = [];
      const verifiedSourcePostingVersionIds: string[] = [];
      const discoveryFacts: RecommendationDiscoveryFacts["trusted"] = [];
      for (const trusted of frozenSources) {
        const source = trusted.source;
        const discoveryAuthorization = authorizeSourceAction({ declaration: input.trustedSourceAdapter.declareCapabilities({ sourceId: source.sourceId }), action: "active_discovery", expected: { sourceId: source.sourceId, adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION } });
        if (!discoveryAuthorization.allowed) {
          sourceIssues.push({ code: discoveryAuthorization.failure.reasonCode, affectedCount: 1 });
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "failed", losses: [{ code: "SOURCE_CAPABILITY_UNAVAILABLE", retryable: false }] });
          continue;
        }
        await beforeRequest(source.watchlistItemId);
        const listed = await input.trustedSourceAdapter.listSource({ targetSnapshot: executionSpec.targetSnapshot, source, signal });
        if (!listed.ok) {
          sourceIssues.push({ code: sourceIssueCode(listed.error.code, "GREENHOUSE_LIST_FAILED"), affectedCount: 1 });
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "failed", losses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: true }] });
          continue;
        }
        const candidateKeys = new Set<string>();
        const observed = new Set(listed.data.observedDetailIds);
        const validList = listed.data.sourceId === source.sourceId
          && listed.data.observedDetailIds.length === observed.size
          && listed.data.candidates.every((candidate) => candidate.sourceId === source.sourceId && observed.has(candidate.detailId) && !candidateKeys.has(candidate.detailId) && (candidateKeys.add(candidate.detailId), true));
        if (!validList) {
          sourceIssues.push({ code: "GREENHOUSE_LIST_IDENTITY_INVALID", affectedCount: 1 });
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "failed", losses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: false }] });
          continue;
        }
        if (listed.data.candidates.length === 0 && listed.data.observedDetailIds.length === 0) {
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "credible_zero", losses: [] });
          continue;
        }
        const details: DiscoveryDetail[] = [];
        let detailFailure = false;
        for (const candidate of listed.data.candidates) {
          const detailAuthorization = authorizeSourceAction({ declaration: input.trustedSourceAdapter.declareCapabilities({ sourceId: source.sourceId }), action: "read_details", expected: { sourceId: source.sourceId, adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION } });
          if (!detailAuthorization.allowed) {
            sourceIssues.push({ code: detailAuthorization.failure.reasonCode, affectedCount: 1 });
            detailFailure = true;
            break;
          }
          await beforeRequest(source.watchlistItemId);
          const detailed = await input.trustedSourceAdapter.getSourceDetail({ source, detailId: candidate.detailId, signal });
          if (!detailed.ok) {
            sourceIssues.push({ code: sourceIssueCode(detailed.error.code, "GREENHOUSE_DETAIL_FAILED"), affectedCount: 1 });
            detailFailure = true;
            continue;
          }
          const detail = detailed.data;
          if (detail.sourceId !== source.sourceId || detail.detailId !== candidate.detailId || detail.sourceType !== "company_careers" || !detail.isOfficial) {
            sourceIssues.push({ code: "GREENHOUSE_DETAIL_IDENTITY_INVALID", affectedCount: 1 });
            detailFailure = true;
            continue;
          }
          details.push(detail);
        }
        if (details.length === 0) {
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "verification_failed", losses: [{ code: "VERIFICATION_FAILED", retryable: false }] });
          continue;
        }
        const storedDetails = details.map((detail) => ({ detail, stored: rawObject({ id: input.id, userId, runId, sourceId: source.sourceId, detail }) }));
        const storedObjects = storedDetails.map(({ stored }) => stored);
        try {
          for (const { detail, stored } of storedDetails) {
            await input.contentStore.put({ objectKey: stored.objectKey, bytes: canonicalJsonBytes(detail.rawPayload), mediaType: "application/json", runId });
          }
          const persisted = await persistence.persistTrustedLayeredDiscovery({
            userId, runId, claimToken, sourceId: source.sourceId, details, storedObjects, now,
          });
          verifiedSourcePostingVersionIds.push(...persisted.sourcePostingVersionIds);
          discoveryFacts.push({ sourceId: source.sourceId, checked: true, outcome: "credible_results", losses: detailFailure ? [{ code: "VERIFICATION_FAILED", retryable: false }] : [] });
          await cleanup(input.contentStore, persisted.cleanupObjectKeys);
        } catch (error) {
          await cleanup(input.contentStore, storedObjects.map((stored) => stored.objectKey));
          throw error;
        }
      }
      return { succeeded: discoveryFacts.some((fact) => fact.outcome === "credible_results" || fact.outcome === "credible_zero"), verifiedSourcePostingVersionIds: [...new Set(verifiedSourcePostingVersionIds)], sourceIssues, discoveryFacts };
    },
  };
  const { db: _db, id: _id, auditTrail: _auditTrail, contentStore: _contentStore, evidenceStore: _evidenceStore, trustedSourceAdapter: _trustedSourceAdapter, afterVerifiedPersistence: _afterVerifiedPersistence, ...workflowDependencies } = input;
  return createLayeredPublicJobDiscoveryWorkflow({
    ...workflowDependencies,
    anySearch: {
      ...workflowDependencies.anySearch,
      extract: (value) => workflowDependencies.anySearch.extract(value),
    },
    trustedSources,
    leads: {
      recordPendingForClaim: ({ targetId, queryKind, candidate, claimToken, now }) => leads.recordPendingForClaim({
        userId: candidate.userId,
        runId: candidate.runId,
        targetId,
        queryId: candidate.queryId,
        queryKind,
        queryFingerprint: candidate.queryFingerprint,
        normalizedUrl: candidate.normalizedUrl,
        stableFingerprint: candidate.stableFingerprint,
        claimToken,
        now,
      }),
      recoverPendingForClaim: (value) => leads.recoverPendingForClaim(value),
      authorizeRecoveredCandidateForClaim: (value) => leads.authorizeRecoveredCandidateForClaim(value),
    },
    gate: {
      verifyForClaim: async (value) => {
        const verified = await gate.verifyForClaim({
          userId: value.candidate.userId, leadId: value.candidate.leadId,
          candidate: { queryId: value.candidate.queryId, normalizedUrl: value.candidate.normalizedUrl, candidateFingerprint: value.candidateFingerprint },
          extract: value.extract, page: value.page, claimToken: value.claimToken, now: value.now,
        });
        await input.afterVerifiedPersistence?.({ normalizedUrl: value.candidate.normalizedUrl });
        return { sourcePostingVersionId: verified.sourcePostingVersion.sourcePostingVersionId };
      },
      rejectForClaim: async (value) => {
        await gate.rejectForClaim({ userId: value.candidate.userId, leadId: value.candidate.leadId, code: value.code, claimToken: value.claimToken, now: value.now });
      },
    },
  });
}
