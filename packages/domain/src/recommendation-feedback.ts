import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { CalibrationProposalResolutionCommand, CalibrationProposalRevisionCommand, RecommendationDecisionCommand } from "@job-copilot/contracts/recommendations";
import { CalibrationProposalResolutionCommandSchema, CalibrationProposalRevisionCommandSchema, RecommendationDecisionCommandSchema, RecommendationRuleConfigSchema } from "@job-copilot/contracts/recommendations";
import {
  calibrationProposalEvidence, calibrationProposalRevisions, calibrationProposals, recommendationDecisionEvents,
  recommendationListItems, recommendationLists, recommendationRuleVersions, jobMatchVersions, type Database,
} from "@job-copilot/database";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";

type DecisionResult = { decision: { status: "saved" | "ignored"; version: number }; proposal: { proposalId: string } | null };
type RuleConfig = { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[]; excludedOpportunityIds: string[] };
const defaultConfig: RuleConfig = { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] };

function summary(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const reasonDimension = { ROLE_DIRECTION: "career_direction", LOCATION: "location_logistics", SALARY: "skills", COMPANY: "qualification_risk", INDUSTRY: "career_direction", SENIORITY: "experience", MISMATCH: "project_depth" } as const;
function ruleDiff(from: RuleConfig, to: RuleConfig) {
  return Object.fromEntries((Object.keys(to) as Array<keyof RuleConfig>).flatMap((key) => JSON.stringify(from[key]) === JSON.stringify(to[key]) ? [] : [[key, { from: from[key], to: to[key] }]]));
}
function proposedRule(reason: string, current: RuleConfig, candidates: Array<{ opportunityId: string; overallScore: number }>) {
  const next = { ...current, requiredEvidenceDimensions: [...current.requiredEvidenceDimensions], excludedOpportunityIds: [...current.excludedOpportunityIds] };
  let strategy: "require_related_evidence" | "raise_quality_bar" | "exclude_evidence_opportunities" = "require_related_evidence";
  if (reason === "EXPIRED" || reason === "ALREADY_HANDLED") { strategy = "exclude_evidence_opportunities"; next.excludedOpportunityIds = [...new Set([...next.excludedOpportunityIds, ...candidates.map((item) => item.opportunityId)])]; }
  else {
    const dimension = reasonDimension[reason as keyof typeof reasonDimension];
    if (dimension) next.requiredEvidenceDimensions = [...new Set([...next.requiredEvidenceDimensions, dimension])];
    const threshold = Math.min(100, Math.max(...candidates.map((item) => item.overallScore)) + 1);
    next.minimumOverallScore = Math.max(next.minimumOverallScore, threshold);
    if (reason === "SALARY" || reason === "MISMATCH") strategy = "raise_quality_bar";
  }
  const diff = ruleDiff(current, next);
  return Object.keys(diff).length ? { strategy, ruleConfig: next, impactPreview: { sampleSize: candidates.length, estimatedAffectedCount: candidates.filter((item) => item.overallScore < next.minimumOverallScore || next.excludedOpportunityIds.includes(item.opportunityId)).length, ruleDiff: diff } } : null;
}

/** Immutable recommendation feedback and review-gated calibration boundary. */
export function createRecommendationFeedbackCommands(deps: { db: Database; id: () => string; clock: () => Date; auditTrail?: AuditTrail }) {
  async function recordDecision(input: { userId: string; recommendationListId: string; recommendationListItemId: string; command: RecommendationDecisionCommand }): Promise<DecisionResult> {
    const command = RecommendationDecisionCommandSchema.parse(input.command);
    const payload = { ...command, reason: command.decision === "ignored" ? command.reason ?? null : null, note: command.decision === "ignored" ? command.note ?? null : null };
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const [existing] = await tx.select().from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.idempotencyKey, command.idempotencyKey))).limit(1);
      const commandSummary = summary({ kind: "recordDecision", recommendationListId: input.recommendationListId, recommendationListItemId: input.recommendationListItemId, payload });
      if (existing) {
        if (existing.commandSummary !== commandSummary) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT");
        const [replayed] = await tx.select({ proposalId: calibrationProposalEvidence.proposalId }).from(calibrationProposalEvidence).where(and(eq(calibrationProposalEvidence.userId, input.userId), eq(calibrationProposalEvidence.decisionEventId, existing.id))).limit(1);
        return { decision: { status: existing.decision as "saved" | "ignored", version: existing.version }, proposal: replayed ? { proposalId: replayed.proposalId } : null };
      }
      const [bound] = await tx.select({ itemId: recommendationListItems.id, listId: recommendationLists.id, targetId: recommendationLists.targetId, matchId: jobMatchVersions.id, opportunityId: jobMatchVersions.opportunityId }).from(recommendationListItems)
        .innerJoin(recommendationLists, and(eq(recommendationLists.userId, recommendationListItems.userId), eq(recommendationLists.id, recommendationListItems.recommendationListId)))
        .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationListItems.userId), eq(jobMatchVersions.id, recommendationListItems.matchVersionId)))
        .where(and(eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.id, input.recommendationListItemId), eq(recommendationListItems.recommendationListId, input.recommendationListId))).limit(1);
      if (!bound || bound.listId !== input.recommendationListId) throw new RecommendationFeedbackError("RECOMMENDATION_ITEM_NOT_FOUND");
      const [current] = await tx.select({ version: recommendationDecisionEvents.version }).from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.recommendationListItemId, input.recommendationListItemId))).orderBy(desc(recommendationDecisionEvents.version)).limit(1);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [event] = await tx.insert(recommendationDecisionEvents).values({ id: deps.id(), userId: input.userId, targetId: bound.targetId, recommendationListId: input.recommendationListId, recommendationListItemId: input.recommendationListItemId, matchVersionId: bound.matchId, decision: command.decision, reason: payload.reason, note: payload.note, idempotencyKey: command.idempotencyKey, commandSummary, expectedVersion: currentVersion, version: currentVersion + 1, createdAt: deps.clock() }).returning();
      if (!event) throw new RecommendationFeedbackError("DECISION_PERSIST_FAILED");
      await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.decision_recorded", occurredAt: deps.clock(), requestId: command.idempotencyKey, outcome: "success", reasonCode: command.decision === "saved" ? "RECOMMENDATION_SAVED" : "RECOMMENDATION_IGNORED", resourceType: "recommendation_list_item", resourceId: input.recommendationListItemId, metadata: { recommendationListId: input.recommendationListId, recommendationListItemId: input.recommendationListItemId, matchVersionId: bound.matchId, action: command.decision, reason: payload.reason, version: event.version } });
      let proposal: { proposalId: string } | null = null;
      if (command.decision === "ignored" && payload.reason) {
        const events = await tx.select().from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.targetId, bound.targetId))).orderBy(desc(recommendationDecisionEvents.version));
        const evidence = await tx.select({ decisionEventId: calibrationProposalEvidence.decisionEventId }).from(calibrationProposalEvidence).where(eq(calibrationProposalEvidence.userId, input.userId));
        const used = new Set(evidence.map((item) => item.decisionEventId)); const currentByItem = new Map<string, typeof events[number]>();
        for (const item of events) if (!currentByItem.has(item.recommendationListItemId)) currentByItem.set(item.recommendationListItemId, item);
        const candidates = [...currentByItem.values()].filter((item) => item.decision === "ignored" && item.reason === payload.reason && !used.has(item.id)).slice(0, 3);
        if (candidates.length === 3) {
          const candidateMatches = await tx.select({ id: jobMatchVersions.id, opportunityId: jobMatchVersions.opportunityId, overallScore: jobMatchVersions.overallScore }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId));
          const matchById = new Map(candidateMatches.map((item) => [item.id, item]));
          const samples = candidates.map((item) => matchById.get(item.matchVersionId)!).filter(Boolean);
          const [latestRule] = await tx.select({ config: recommendationRuleVersions.config }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, bound.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
          const strategy = proposedRule(payload.reason, RecommendationRuleConfigSchema.parse(latestRule?.config ?? defaultConfig), samples);
          if (!strategy) return { decision: { status: command.decision, version: currentVersion + 1 }, proposal: null };
          const [created] = await tx.insert(calibrationProposals).values({ id: deps.id(), userId: input.userId, targetId: bound.targetId, reason: payload.reason, status: "pending", version: 1, createdAt: deps.clock(), updatedAt: deps.clock() }).returning();
          if (!created) throw new RecommendationFeedbackError("PROPOSAL_PERSIST_FAILED");
          await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: created.id, revisionNumber: 1, strategy: strategy.strategy, ruleConfig: strategy.ruleConfig, impactPreview: strategy.impactPreview, idempotencyKey: deps.id(), commandSummary: summary(strategy), createdAt: deps.clock() });
          await tx.insert(calibrationProposalEvidence).values(candidates.map((item) => ({ id: deps.id(), userId: input.userId, proposalId: created.id, decisionEventId: item.id, createdAt: deps.clock() })));
          await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: event.id, outcome: "success", reasonCode: "CALIBRATION_PROPOSAL_CREATED", resourceType: "calibration_proposal", resourceId: created.id, metadata: { proposalId: created.id, targetId: bound.targetId, action: "created", version: 1, evidenceCount: candidates.length } });
          proposal = { proposalId: created.id };
        }
      }
      return { decision: { status: command.decision, version: currentVersion + 1 }, proposal };
    });
  }

  async function reviseCalibrationProposal(input: { userId: string; proposalId: string; command: CalibrationProposalRevisionCommand }) {
    const command = CalibrationProposalRevisionCommandSchema.parse(input.command);
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const digest = summary({ kind: "reviseCalibrationProposal", proposalId: input.proposalId, command }); const [existing] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) { if (existing.commandSummary !== digest) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT"); return existing; }
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId), eq(calibrationProposals.status, "pending"))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND");
      if (proposal.version !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [latest] = await tx.select({ revisionNumber: calibrationProposalRevisions.revisionNumber }).from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      const [revision] = await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: proposal.id, revisionNumber: (latest?.revisionNumber ?? 0) + 1, strategy: command.strategy, ruleConfig: command.ruleConfig, impactPreview: command.impactPreview, idempotencyKey: command.idempotencyKey, commandSummary: digest, createdAt: deps.clock() }).returning();
      await tx.update(calibrationProposals).set({ version: proposal.version + 1, updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version)));
      await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: command.idempotencyKey, outcome: "success", reasonCode: "CALIBRATION_PROPOSAL_REVISED", resourceType: "calibration_proposal", resourceId: proposal.id, metadata: { proposalId: proposal.id, targetId: proposal.targetId, action: "revised", version: proposal.version + 1, evidenceCount: 0 } });
      return revision;
    });
  }

  async function resolveCalibrationProposal(input: { userId: string; proposalId: string; command: CalibrationProposalResolutionCommand }) {
    const command = CalibrationProposalResolutionCommandSchema.parse(input.command);
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const digest = summary({ kind: "resolveCalibrationProposal", proposalId: input.proposalId, command });
      const [priorResolution] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.resolutionIdempotencyKey, command.idempotencyKey))).limit(1);
      if (priorResolution && (priorResolution.id !== input.proposalId || priorResolution.resolutionCommandSummary !== digest)) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT");
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND");
      if (proposal.resolutionIdempotencyKey) {
        if (proposal.resolutionIdempotencyKey !== command.idempotencyKey || proposal.resolutionCommandSummary !== digest) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT");
        const [existingRule] = proposal.status === "approved" ? await tx.select({ version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.proposalId, proposal.id))).limit(1) : [];
        return { proposalId: proposal.id, status: proposal.status, ruleVersion: existingRule ? `recommendation-rule-v${existingRule.version}` : null };
      }
      if (proposal.status !== "pending" || proposal.version !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [revision] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
      let ruleVersion: string | null = null;
      if (command.action === "approved") {
        const [previous] = await tx.select({ version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
        const version = (previous?.version ?? 0) + 1;
        await tx.insert(recommendationRuleVersions).values({ id: deps.id(), userId: input.userId, targetId: proposal.targetId, proposalId: proposal.id, proposalRevisionId: revision.id, version, config: RecommendationRuleConfigSchema.parse(revision.ruleConfig), createdAt: deps.clock() });
        ruleVersion = `recommendation-rule-v${version}`;
      }
      const [updated] = await tx.update(calibrationProposals).set({ status: command.action, version: proposal.version + 1, resolvedAt: deps.clock(), resolutionIdempotencyKey: command.idempotencyKey, resolutionCommandSummary: digest, updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version))).returning();
      if (!updated) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: command.idempotencyKey, outcome: "success", reasonCode: command.action === "approved" ? "CALIBRATION_PROPOSAL_APPROVED" : "CALIBRATION_PROPOSAL_REJECTED", resourceType: "calibration_proposal", resourceId: proposal.id, metadata: { proposalId: proposal.id, targetId: proposal.targetId, action: command.action, version: updated.version, evidenceCount: 0 } });
      return { proposalId: proposal.id, status: updated.status, ruleVersion };
    });
  }
  return { recordDecision, reviseCalibrationProposal, resolveCalibrationProposal };
}

export function createRecommendationFeedbackQueries(deps: { db: Database }) {
  return {
    async listCalibrationProposals(input: { userId: string; targetId: string }) {
      const proposals = await deps.db.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.targetId, input.targetId))).orderBy(desc(calibrationProposals.createdAt));
      return Promise.all(proposals.map(async (proposal) => {
        const [revision] = await deps.db.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
        const evidence = await deps.db.select({ id: calibrationProposalEvidence.id }).from(calibrationProposalEvidence).where(and(eq(calibrationProposalEvidence.userId, input.userId), eq(calibrationProposalEvidence.proposalId, proposal.id)));
        if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
        return { proposalId: proposal.id, targetId: proposal.targetId, status: proposal.status, version: proposal.version, evidenceCount: evidence.length, revision: { revisionId: revision.id, revisionNumber: revision.revisionNumber, strategy: revision.strategy, ruleConfig: revision.ruleConfig, impactPreview: revision.impactPreview } };
      }));
    },
  };
}

export class RecommendationFeedbackError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "VERSION_CONFLICT" | "RECOMMENDATION_ITEM_NOT_FOUND" | "DECISION_PERSIST_FAILED" | "PROPOSAL_PERSIST_FAILED" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_REVISION_NOT_FOUND") { super(code); }
}
