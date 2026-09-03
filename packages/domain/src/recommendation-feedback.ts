import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { CalibrationProposalCommandResponse, CalibrationProposalRebaseCommand, CalibrationProposalResolutionCommand, CalibrationProposalRevisionCommand, RecommendationDecisionCommand, RecommendationRuleConfig } from "@job-copilot/contracts/recommendations";
import { acceptsRecommendationRule, CalibrationImpactPreviewSchema, CalibrationProposalCommandResponseSchema, CalibrationProposalRebaseCommandSchema, CalibrationProposalResolutionCommandSchema, CalibrationProposalRevisionCommandSchema, RecommendationDecisionCommandSchema, RecommendationRuleConfigSchema } from "@job-copilot/contracts/recommendations";
import { DeepMatchAssessmentSchema } from "@job-copilot/contracts/deep-match";
import {
  calibrationProposalEvidence, calibrationProposalRevisions, calibrationProposals, recommendationDecisionEvents, recommendationDecisionResponses,
  recommendationListItems, recommendationLists, recommendationRuleVersions, jobMatchVersions, type Database,
} from "@job-copilot/database";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";

type DecisionResult = { decision: { status: "saved" | "ignored"; version: number }; proposal: { proposalId: string } | null };
type RuleConfig = RecommendationRuleConfig;
const defaultConfig: RuleConfig = { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] };

function summary(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function calibrationProposalCommandResponse(revision: { id: string; proposalId: string; revisionNumber: number }): CalibrationProposalCommandResponse {
  return CalibrationProposalCommandResponseSchema.parse({ proposalId: revision.proposalId, revisionId: revision.id, revisionNumber: revision.revisionNumber });
}
const reasonDimension = { ROLE_DIRECTION: "career_direction", LOCATION: "location_logistics", SALARY: "skills", COMPANY: "qualification_risk", INDUSTRY: "career_direction", SENIORITY: "experience", MISMATCH: "project_depth" } as const;
function ruleDiff(from: RuleConfig, to: RuleConfig) {
  return Object.fromEntries((Object.keys(to) as Array<keyof RuleConfig>).flatMap((key) => JSON.stringify(from[key]) === JSON.stringify(to[key]) ? [] : [[key, { from: from[key], to: to[key] }]]));
}
type CalibrationSample = { opportunityId: string; overallScore: number; assessment: Parameters<typeof acceptsRecommendationRule>[0] };
function acceptsRuleSnapshot(assessment: unknown, config: RuleConfig): boolean {
  const parsed = DeepMatchAssessmentSchema.safeParse(assessment);
  return parsed.success && acceptsRecommendationRule(parsed.data, config);
}
function impactPreview(active: RuleConfig, next: RuleConfig, candidates: CalibrationSample[]) {
  return { sampleSize: candidates.length, estimatedAffectedCount: candidates.filter((item) => acceptsRuleSnapshot(item.assessment, active) && !acceptsRuleSnapshot(item.assessment, next)).length, ruleDiff: ruleDiff(active, next) };
}
function proposedRule(reason: string, current: RuleConfig, active: RuleConfig, candidates: CalibrationSample[], selectedStrategy?: "require_related_evidence" | "raise_quality_bar" | "exclude_evidence_opportunities") {
  const next = { ...current, requiredEvidenceDimensions: [...current.requiredEvidenceDimensions], excludedOpportunityIds: [...current.excludedOpportunityIds] };
  const strategy = selectedStrategy ?? (reason === "EXPIRED" || reason === "ALREADY_HANDLED" ? "exclude_evidence_opportunities" : reason === "SALARY" || reason === "MISMATCH" ? "raise_quality_bar" : "require_related_evidence");
  if (strategy === "exclude_evidence_opportunities") next.excludedOpportunityIds = [...new Set([...next.excludedOpportunityIds, ...candidates.map((item) => item.opportunityId)])];
  if (strategy === "require_related_evidence") {
    const dimension = reasonDimension[reason as keyof typeof reasonDimension];
    if (dimension) next.requiredEvidenceDimensions = [...new Set([...next.requiredEvidenceDimensions, dimension])];
  }
  if (strategy === "raise_quality_bar") {
    const threshold = Math.min(100, Math.max(...candidates.map((item) => item.overallScore)) + 1);
    next.minimumOverallScore = Math.max(next.minimumOverallScore, threshold);
  }
  const mutation = ruleDiff(current, next);
  const parsed = RecommendationRuleConfigSchema.safeParse(next);
  // 是否可创建 revision 取决于相对上一 revision 的真实变更；审阅展示则始终相对已批准的 active rule。
  return Object.keys(mutation).length && parsed.success ? { strategy, ruleConfig: parsed.data, impactPreview: impactPreview(active, parsed.data, candidates) } : null;
}

/**
 * 将 proposal 相对其 immutable 基准的单调收紧意图重放到当前生效规则。
 * 不能证明为单调收紧时拒绝，而不是悄悄丢弃用户已审核的字段。
 */
function effectiveProposalRule(base: RuleConfig, latest: RuleConfig, active: RuleConfig): RuleConfig {
  const includesAll = (values: string[], expected: string[]) => expected.every((value) => values.includes(value));
  if (latest.minimumOverallScore < base.minimumOverallScore || latest.minimumEvidenceDimensions < base.minimumEvidenceDimensions || !includesAll(latest.requiredEvidenceDimensions, base.requiredEvidenceDimensions) || !includesAll(latest.excludedOpportunityIds, base.excludedOpportunityIds)) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
  const parsed = RecommendationRuleConfigSchema.safeParse({
    minimumOverallScore: Math.max(active.minimumOverallScore, latest.minimumOverallScore),
    minimumEvidenceDimensions: Math.max(active.minimumEvidenceDimensions, latest.minimumEvidenceDimensions),
    requiredEvidenceDimensions: [...new Set([...active.requiredEvidenceDimensions, ...latest.requiredEvidenceDimensions])],
    excludedOpportunityIds: [...new Set([...active.excludedOpportunityIds, ...latest.excludedOpportunityIds])],
  });
  if (!parsed.success) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
  return parsed.data;
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
        const [replayed] = await tx.select({ proposalId: recommendationDecisionResponses.proposalId }).from(recommendationDecisionResponses).where(and(eq(recommendationDecisionResponses.userId, input.userId), eq(recommendationDecisionResponses.decisionEventId, existing.id))).limit(1);
        return { decision: { status: existing.decision as "saved" | "ignored", version: existing.version }, proposal: replayed?.proposalId ? { proposalId: replayed.proposalId } : null };
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
          const candidateMatches = await tx.select({ id: jobMatchVersions.id, opportunityId: jobMatchVersions.opportunityId, overallScore: jobMatchVersions.overallScore, assessment: jobMatchVersions.assessment }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId));
          const matchById = new Map(candidateMatches.map((item) => [item.id, item]));
          const samples = candidates.map((item) => matchById.get(item.matchVersionId)!).filter(Boolean).map((item) => ({ ...item, assessment: item.assessment as CalibrationSample["assessment"] }));
          const [latestRule] = await tx.select({ config: recommendationRuleVersions.config, version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, bound.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
          const active = RecommendationRuleConfigSchema.parse(latestRule?.config ?? defaultConfig);
          const strategy = proposedRule(payload.reason, active, active, samples);
          if (strategy) {
            const [created] = await tx.insert(calibrationProposals).values({ id: deps.id(), userId: input.userId, targetId: bound.targetId, reason: payload.reason, status: "pending", version: 1, createdAt: deps.clock(), updatedAt: deps.clock() }).returning();
            if (!created) throw new RecommendationFeedbackError("PROPOSAL_PERSIST_FAILED");
            await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: created.id, revisionNumber: 1, baseRuleVersion: latestRule?.version ?? 0, strategy: strategy.strategy, ruleConfig: strategy.ruleConfig, impactPreview: strategy.impactPreview, idempotencyKey: deps.id(), commandSummary: summary(strategy), createdAt: deps.clock() });
            await tx.insert(calibrationProposalEvidence).values(candidates.map((item) => ({ id: deps.id(), userId: input.userId, proposalId: created.id, decisionEventId: item.id, createdAt: deps.clock() })));
            await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: event.id, outcome: "success", reasonCode: "CALIBRATION_PROPOSAL_CREATED", resourceType: "calibration_proposal", resourceId: created.id, metadata: { proposalId: created.id, targetId: bound.targetId, action: "created", version: 1, evidenceCount: candidates.length } });
            proposal = { proposalId: created.id };
          }
        }
      }
      await tx.insert(recommendationDecisionResponses).values({ id: deps.id(), userId: input.userId, decisionEventId: event.id, proposalId: proposal?.proposalId ?? null, createdAt: deps.clock() });
      return { decision: { status: command.decision, version: currentVersion + 1 }, proposal };
    });
  }

  async function reviseCalibrationProposal(input: { userId: string; proposalId: string; command: CalibrationProposalRevisionCommand }) {
    const command = CalibrationProposalRevisionCommandSchema.parse(input.command);
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const digest = summary({ kind: "reviseCalibrationProposal", proposalId: input.proposalId, command }); const [existing] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) { if (existing.commandSummary !== digest) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT"); return calibrationProposalCommandResponse(existing); }
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId), eq(calibrationProposals.status, "pending"))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND");
      if (proposal.version !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [latest] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      if (!latest) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
      const evidenceMatches = await tx.select({ opportunityId: jobMatchVersions.opportunityId, overallScore: jobMatchVersions.overallScore, assessment: jobMatchVersions.assessment }).from(calibrationProposalEvidence)
        .innerJoin(recommendationDecisionEvents, and(eq(recommendationDecisionEvents.userId, calibrationProposalEvidence.userId), eq(recommendationDecisionEvents.id, calibrationProposalEvidence.decisionEventId)))
        .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationDecisionEvents.userId), eq(jobMatchVersions.id, recommendationDecisionEvents.matchVersionId)))
        .where(and(eq(calibrationProposalEvidence.userId, input.userId), eq(calibrationProposalEvidence.proposalId, proposal.id)));
      const [activeRule] = await tx.select({ config: recommendationRuleVersions.config, version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
      const active = RecommendationRuleConfigSchema.parse(activeRule?.config ?? defaultConfig);
      const [baseRule] = latest.baseRuleVersion === 0 ? [] : await tx.select({ config: recommendationRuleVersions.config }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId), eq(recommendationRuleVersions.version, latest.baseRuleVersion))).limit(1);
      if (latest.baseRuleVersion !== 0 && !baseRule) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
      const current = effectiveProposalRule(RecommendationRuleConfigSchema.parse(baseRule?.config ?? defaultConfig), RecommendationRuleConfigSchema.parse(latest.ruleConfig), active);
      const derived = proposedRule(proposal.reason, current, active, evidenceMatches.map((item) => ({ ...item, assessment: item.assessment as CalibrationSample["assessment"] })), command.strategy);
      if (!derived) throw new RecommendationFeedbackError("PROPOSAL_NO_EFFECT");
      const [revision] = await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: proposal.id, revisionNumber: latest.revisionNumber + 1, baseRuleVersion: activeRule?.version ?? 0, strategy: derived.strategy, ruleConfig: derived.ruleConfig, impactPreview: derived.impactPreview, idempotencyKey: command.idempotencyKey, commandSummary: digest, createdAt: deps.clock() }).returning();
      await tx.update(calibrationProposals).set({ version: proposal.version + 1, updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version)));
      await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: command.idempotencyKey, outcome: "success", reasonCode: "CALIBRATION_PROPOSAL_REVISED", resourceType: "calibration_proposal", resourceId: proposal.id, metadata: { proposalId: proposal.id, targetId: proposal.targetId, action: "revised", version: proposal.version + 1, evidenceCount: 0 } });
      if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
      return calibrationProposalCommandResponse(revision);
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
        if (revision.baseRuleVersion !== (previous?.version ?? 0)) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
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
  async function rebaseCalibrationProposal(input: { userId: string; proposalId: string; command: CalibrationProposalRebaseCommand }) {
    const command = CalibrationProposalRebaseCommandSchema.parse(input.command);
    return deps.db.transaction(async (tx) => {
      await acquireAccountAdvisoryLock(tx, input.userId);
      const digest = summary({ kind: "rebaseCalibrationProposal", proposalId: input.proposalId, command }); const [existing] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) { if (existing.commandSummary !== digest) throw new RecommendationFeedbackError("IDEMPOTENCY_CONFLICT"); return calibrationProposalCommandResponse(existing); }
      const [proposal] = await tx.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, input.proposalId), eq(calibrationProposals.status, "pending"))).limit(1);
      if (!proposal) throw new RecommendationFeedbackError("PROPOSAL_NOT_FOUND"); if (proposal.version !== command.expectedVersion) throw new RecommendationFeedbackError("VERSION_CONFLICT");
      const [latest] = await tx.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
      const [activeRule] = await tx.select({ config: recommendationRuleVersions.config, version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
      const [baseRule] = latest && latest.baseRuleVersion !== 0 ? await tx.select({ config: recommendationRuleVersions.config }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId), eq(recommendationRuleVersions.version, latest.baseRuleVersion))).limit(1) : [];
      if (!latest || (latest.baseRuleVersion !== 0 && !baseRule)) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
      const evidenceMatches = await tx.select({ opportunityId: jobMatchVersions.opportunityId, overallScore: jobMatchVersions.overallScore, assessment: jobMatchVersions.assessment }).from(calibrationProposalEvidence)
        .innerJoin(recommendationDecisionEvents, and(eq(recommendationDecisionEvents.userId, calibrationProposalEvidence.userId), eq(recommendationDecisionEvents.id, calibrationProposalEvidence.decisionEventId)))
        .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationDecisionEvents.userId), eq(jobMatchVersions.id, recommendationDecisionEvents.matchVersionId)))
        .where(and(eq(calibrationProposalEvidence.userId, input.userId), eq(calibrationProposalEvidence.proposalId, proposal.id)));
      const active = RecommendationRuleConfigSchema.parse(activeRule?.config ?? defaultConfig); const current = effectiveProposalRule(RecommendationRuleConfigSchema.parse(baseRule?.config ?? defaultConfig), RecommendationRuleConfigSchema.parse(latest.ruleConfig), active);
      if (latest.baseRuleVersion === (activeRule?.version ?? 0) || !Object.keys(ruleDiff(active, current)).length) throw new RecommendationFeedbackError("PROPOSAL_NO_EFFECT");
      const [revision] = await tx.insert(calibrationProposalRevisions).values({ id: deps.id(), userId: input.userId, proposalId: proposal.id, revisionNumber: latest.revisionNumber + 1, baseRuleVersion: activeRule?.version ?? 0, strategy: latest.strategy, ruleConfig: current, impactPreview: impactPreview(active, current, evidenceMatches.map((item) => ({ ...item, assessment: item.assessment as CalibrationSample["assessment"] }))), idempotencyKey: command.idempotencyKey, commandSummary: digest, createdAt: deps.clock() }).returning();
      await tx.update(calibrationProposals).set({ version: proposal.version + 1, updatedAt: deps.clock() }).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.id, proposal.id), eq(calibrationProposals.version, proposal.version)));
      await deps.auditTrail?.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "recommendation.calibration_proposal", occurredAt: deps.clock(), requestId: command.idempotencyKey, outcome: "success", reasonCode: "CALIBRATION_PROPOSAL_REBASED", resourceType: "calibration_proposal", resourceId: proposal.id, metadata: { proposalId: proposal.id, targetId: proposal.targetId, action: "rebased", version: proposal.version + 1, evidenceCount: evidenceMatches.length } });
      if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
      return calibrationProposalCommandResponse(revision);
    });
  }
  return { recordDecision, reviseCalibrationProposal, rebaseCalibrationProposal, resolveCalibrationProposal };
}

export function createRecommendationFeedbackQueries(deps: { db: Database }) {
  return {
    async listCalibrationProposals(input: { userId: string; targetId: string }) {
      const proposals = await deps.db.select().from(calibrationProposals).where(and(eq(calibrationProposals.userId, input.userId), eq(calibrationProposals.targetId, input.targetId))).orderBy(desc(calibrationProposals.createdAt));
      return Promise.all(proposals.map(async (proposal) => {
        const [revision] = await deps.db.select().from(calibrationProposalRevisions).where(and(eq(calibrationProposalRevisions.userId, input.userId), eq(calibrationProposalRevisions.proposalId, proposal.id))).orderBy(desc(calibrationProposalRevisions.revisionNumber)).limit(1);
        const evidence = await deps.db.select({ id: calibrationProposalEvidence.id, opportunityId: jobMatchVersions.opportunityId, overallScore: jobMatchVersions.overallScore, assessment: jobMatchVersions.assessment }).from(calibrationProposalEvidence).innerJoin(recommendationDecisionEvents, and(eq(recommendationDecisionEvents.userId, calibrationProposalEvidence.userId), eq(recommendationDecisionEvents.id, calibrationProposalEvidence.decisionEventId))).innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationDecisionEvents.userId), eq(jobMatchVersions.id, recommendationDecisionEvents.matchVersionId))).where(and(eq(calibrationProposalEvidence.userId, input.userId), eq(calibrationProposalEvidence.proposalId, proposal.id)));
        if (!revision) throw new RecommendationFeedbackError("PROPOSAL_REVISION_NOT_FOUND");
        if (proposal.status !== "pending") return {
          proposalId: proposal.id, targetId: proposal.targetId, reason: proposal.reason, status: proposal.status, version: proposal.version, evidenceCount: evidence.length,
          reviewState: "resolved" as const, availableStrategies: [],
          revision: { revisionId: revision.id, revisionNumber: revision.revisionNumber, strategy: revision.strategy, ruleConfig: RecommendationRuleConfigSchema.parse(revision.ruleConfig), impactPreview: CalibrationImpactPreviewSchema.parse(revision.impactPreview) },
        };
        const [activeRule] = await deps.db.select({ config: recommendationRuleVersions.config, version: recommendationRuleVersions.version }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId))).orderBy(desc(recommendationRuleVersions.version)).limit(1);
        const [baseRule] = revision.baseRuleVersion === 0 ? [] : await deps.db.select({ config: recommendationRuleVersions.config }).from(recommendationRuleVersions).where(and(eq(recommendationRuleVersions.userId, input.userId), eq(recommendationRuleVersions.targetId, proposal.targetId), eq(recommendationRuleVersions.version, revision.baseRuleVersion))).limit(1);
        const active = RecommendationRuleConfigSchema.parse(activeRule?.config ?? defaultConfig); const samples = evidence.map((item) => ({ ...item, assessment: item.assessment as CalibrationSample["assessment"] }));
        const stale = revision.baseRuleVersion !== (activeRule?.version ?? 0);
        try {
          if (revision.baseRuleVersion !== 0 && !baseRule) throw new RecommendationFeedbackError("RULE_VERSION_CONFLICT");
          const current = effectiveProposalRule(RecommendationRuleConfigSchema.parse(baseRule?.config ?? defaultConfig), RecommendationRuleConfigSchema.parse(revision.ruleConfig), active);
          const preview = impactPreview(active, current, samples);
          const covered = Object.keys(preview.ruleDiff).length === 0;
          const availableStrategies = covered ? [] : (["require_related_evidence", "raise_quality_bar", "exclude_evidence_opportunities"] as const).filter((strategy) => Boolean(proposedRule(proposal.reason, current, active, samples, strategy)));
          return { proposalId: proposal.id, targetId: proposal.targetId, reason: proposal.reason, status: proposal.status, version: proposal.version, evidenceCount: evidence.length, reviewState: covered ? "covered" as const : stale ? "stale_rebase_required" as const : "current" as const, availableStrategies, revision: { revisionId: revision.id, revisionNumber: revision.revisionNumber, strategy: revision.strategy, ruleConfig: current, impactPreview: preview } };
        } catch (error) {
          if (!(error instanceof RecommendationFeedbackError) || error.code !== "RULE_VERSION_CONFLICT") throw error;
          return { proposalId: proposal.id, targetId: proposal.targetId, reason: proposal.reason, status: proposal.status, version: proposal.version, evidenceCount: evidence.length, reviewState: "unrebasable" as const, availableStrategies: [], revision: { revisionId: revision.id, revisionNumber: revision.revisionNumber, strategy: revision.strategy, ruleConfig: RecommendationRuleConfigSchema.parse(revision.ruleConfig), impactPreview: CalibrationImpactPreviewSchema.parse(revision.impactPreview) } };
        }
      }));
    },
  };
}

export class RecommendationFeedbackError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "VERSION_CONFLICT" | "RULE_VERSION_CONFLICT" | "RECOMMENDATION_ITEM_NOT_FOUND" | "DECISION_PERSIST_FAILED" | "PROPOSAL_PERSIST_FAILED" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_REVISION_NOT_FOUND" | "PROPOSAL_NO_EFFECT") { super(code); }
}
