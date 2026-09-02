import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { CalibrationProposalResolutionCommand, CalibrationProposalRevisionCommand, RecommendationDecisionCommand } from "@job-copilot/contracts/recommendations";
import { CalibrationProposalRevisionCommandSchema, RecommendationDecisionCommandSchema, RecommendationRuleConfigSchema } from "@job-copilot/contracts/recommendations";
import {
  calibrationProposalEvidence, calibrationProposalRevisions, calibrationProposals, recommendationDecisionEvents,
  recommendationListItems, recommendationLists, recommendationRuleVersions, jobMatchVersions, type Database,
} from "@job-copilot/database";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

type DecisionResult = { decision: { status: "saved" | "ignored"; version: number }; proposal: { proposalId: string } | null };
type TransactionOverride = (tx: any, input: Record<string, unknown>) => Promise<DecisionResult>;
const defaultConfig = { minimumOverallScore: 60, minimumEvidenceDimensions: 2, requiredEvidenceDimensions: [], excludedOpportunityIds: [] };

function summary(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function defaultStrategy(reason: string, opportunityId: string) {
  if (reason === "EXPIRED" || reason === "ALREADY_HANDLED") return { strategy: "exclude_evidence_opportunities" as const, ruleConfig: { ...defaultConfig, excludedOpportunityIds: [opportunityId] } };
  return { strategy: "require_related_evidence" as const, ruleConfig: defaultConfig };
}

/** Immutable recommendation feedback and review-gated calibration boundary. */
export function createRecommendationFeedbackCommands(deps: { db: Database; id: () => string; clock: () => Date; transaction?: TransactionOverride }) {
  async function recordDecision(input: { userId: string; recommendationListId: string; recommendationListItemId: string; command: RecommendationDecisionCommand }): Promise<DecisionResult> {
    const command = RecommendationDecisionCommandSchema.parse(input.command);
    const payload = { ...command, reason: command.decision === "ignored" ? command.reason ?? null : null, note: command.decision === "ignored" ? command.note ?? null : null };
    if (deps.transaction) return deps.db.transaction((tx) => deps.transaction!(tx, { ...input, ...payload }));
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const [existing] = await tx.select().from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.idempotencyKey, command.idempotencyKey))).limit(1);
      const commandSummary = summary(payload);
      if (existing) {
        if (existing.commandSummary !== commandSummary) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT");
        return { decision: { status: existing.decision as "saved" | "ignored", version: existing.version }, proposal: null };
      }
      const [bound] = await tx.select({ itemId: recommendationListItems.id, listId: recommendationLists.id, targetId: recommendationLists.targetId, matchId: jobMatchVersions.id }).from(recommendationListItems)
        .innerJoin(recommendationLists, and(eq(recommendationLists.userId, recommendationListItems.userId), eq(recommendationLists.id, recommendationListItems.recommendationListId)))
        .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationListItems.userId), eq(jobMatchVersions.id, recommendationListItems.matchVersionId)))
        .where(and(eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.id, input.recommendationListItemId), eq(recommendationListItems.recommendationListId, input.recommendationListId))).limit(1);
      if (!bound || bound.listId !== input.recommendationListId) throw new RecommendationFeedbackError("RECOMMENDATION_ITEM_NOT_FOUND");
      const [current] = await tx.select({ version: recommendationDecisionEvents.version }).from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.recommendationListItemId, input.recommendationListItemId))).orderBy(desc(recommendationDecisionEvents.createdAt), desc(recommendationDecisionEvents.id)).limit(1);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [event] = await tx.insert(recommendationDecisionEvents).values({ id: deps.id(), userId: input.userId, targetId: bound.targetId, recommendationListId: input.recommendationListId, recommendationListItemId: input.recommendationListItemId, matchVersionId: bound.matchId, decision: command.decision, reason: payload.reason, note: payload.note, idempotencyKey: command.idempotencyKey, commandSummary, expectedVersion: currentVersion, version: currentVersion + 1, createdAt: deps.clock() }).returning();
      if (!event) throw new RecommendationFeedbackError("DECISION_PERSIST_FAILED");
      let proposal: { proposalId: string } | null = null;
      if (command.decision === "ignored" && payload.reason) {
        const events = await tx.select().from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.targetId, bound.targetId), eq(recommendationDecisionEvents.reason, payload.reason))).orderBy(desc(recommendationDecisionEvents.createdAt), desc(recommendationDecisionEvents.id));
        const evidence = await tx.select({ decisionEventId: calibrationProposalEvidence.decisionEventId }).from(calibrationProposalEvidence).where(eq(calibrationProposalEvidence.userId, input.userId));
        const used = new Set(evidence.map((item) => item.decisionEventId)); const currentByItem = new Map<string, typeof events[number]>();
        for (const item of events) if (!currentByItem.has(item.recommendationListItemId)) currentByItem.set(item.recommendationListItemId, item);
        const candidates = [...currentByItem.values()].filter((item) => item.decision === "ignored" && !used.has(item.id)).slice(0, 3);
        if (candidates.length === 3) {
          const [created] = await tx.insert(calibrationProposals).values({ id: deps.id(), userId: input.userId, targetId: bound.targetId, reason: payload.reason, status: "pending", version: 1, createdAt: deps.clock(), updatedAt: deps.clock() }).returning();
          if (!created) throw new RecommendationFeedbackError("PROPOSAL_PERSIST_FAILED");
          const strategy = defaultStrategy(payload.reason, event.matchVersionId);
          await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: created.id, revisionNumber: 1, strategy: strategy.strategy, ruleConfig: strategy.ruleConfig, impactPreview: { sampleSize: 3, estimatedAffectedCount: 0, ruleDiff: {} }, idempotencyKey: deps.id(), commandSummary: summary(strategy), createdAt: deps.clock() });
          await tx.insert(calibrationProposalEvidence).values(candidates.map((item) => ({ id: deps.id(), userId: input.userId, proposalId: created.id, decisionEventId: item.id, createdAt: deps.clock() })));
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
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId), eq(calibrationProposals.status, "pending"))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND");
      if (proposal.version !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const digest = summary(command); const [existing] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) { if (existing.commandSummary !== digest) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT"); return existing; }
      const [latest] = await tx.select({ revisionNumber: calibrationProposalRevisions.revisionNumber }).from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      const [revision] = await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: proposal.id, revisionNumber: (latest?.revisionNumber ?? 0) + 1, strategy: command.strategy, ruleConfig: command.ruleConfig, impactPreview: command.impactPreview, idempotencyKey: command.idempotencyKey, commandSummary: digest, createdAt: deps.clock() }).returning();
      await tx.update(calibrationProposals).set({ version: proposal.version + 1, updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version)));
      return revision;
    });
  }

  async function resolveCalibrationProposal(input: { userId: string; proposalId: string; command: CalibrationProposalResolutionCommand }) {
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId), eq(calibrationProposals.status, "pending"))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND");
      if (proposal.version !== input.command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [revision] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
      let ruleVersion: string | null = null;
      if (input.command.action === "approved") {
        const [previous] = await tx.select({ version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
        const version = (previous?.version ?? 0) + 1;
        await tx.insert(recommendationRuleVersions).values({ id: deps.id(), userId: input.userId, targetId: proposal.targetId, proposalId: proposal.id, proposalRevisionId: revision.id, version, config: RecommendationRuleConfigSchema.parse(revision.ruleConfig), createdAt: deps.clock() });
        ruleVersion = `recommendation-rule-v${version}`;
      }
      const [updated] = await tx.update(calibrationProposals).set({ status: input.command.action, version: proposal.version + 1, resolvedAt: deps.clock(), updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version))).returning();
      if (!updated) throw new RecommendationFeedbackError("VERSION_CONFLICT");
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
