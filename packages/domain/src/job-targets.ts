import { and, asc, eq, sql } from "drizzle-orm";
import {
  jobTargetRevisions,
  jobTargets,
  type Database,
} from "@job-copilot/database";
import {
  CreateJobTargetCommandSchema,
  DeactivateJobTargetCommandSchema,
  JobTargetConstraintsSchema,
  JobTargetOverviewSchema,
  JobTargetSchema,
  ReviseJobTargetCommandSchema,
  type CreateJobTargetCommand,
  type DeactivateJobTargetCommand,
  type JobTarget,
  type JobTargetOverview,
  type JobTargetSuggestion,
  type ReviseJobTargetCommand,
} from "@job-copilot/contracts/job-targets";
import type { ProfileFact } from "@job-copilot/contracts/profile-review";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createTrustedProfileQueries } from "./profile-review";

export class JobTargetError extends Error {
  constructor(public readonly code:
    | "JOB_TARGET_NOT_FOUND"
    | "JOB_TARGET_VERSION_CONFLICT"
    | "JOB_TARGET_PRIMARY_LIMIT"
    | "JOB_TARGET_SECONDARY_LIMIT",
  ) {
    super(code);
  }
}

const catalog = [
  { id: "45d6f4e4-7af6-4d0e-a6d4-f9e7cd3a4f01", roleFamily: "前端工程师", keywords: ["react", "typescript", "vue", "javascript", "前端"] },
  { id: "e4cfd514-3d53-4688-9e17-ed2801c5d5f8", roleFamily: "全栈工程师", keywords: ["typescript", "node", "后端", "api", "全栈"] },
  { id: "1d2d6a2d-2c30-4d8c-a813-b3d11279e0e7", roleFamily: "AI 应用工程师", keywords: ["ai 应用", "大模型", "llm", "人工智能"] },
  { id: "40b765d0-a6cc-48cb-8807-6b4cd0d7b717", roleFamily: "Agent 工程师", keywords: ["agent", "workflow", "工作流", "工具调用", "智能体"] },
] as const;

function factLabel(fact: ProfileFact): string {
  if ("summary" in fact.factValue) return fact.factValue.summary;
  if (fact.factType === "language" && "level" in fact.factValue && fact.factValue.level) {
    return `${fact.factValue.name}（${fact.factValue.level}）`;
  }
  return fact.factValue.name;
}

function factText(fact: ProfileFact): string {
  return factLabel(fact).toLocaleLowerCase("zh-CN");
}

/** 基于当前可信画像事实生成只读的、可追溯的方向建议。 */
export function suggestJobTargetDirections(facts: ProfileFact[]): JobTargetSuggestion[] {
  if (!facts.length) return [];

  const scored = catalog.map((entry, index) => {
    const evidence = facts.filter((fact) => entry.keywords.some((keyword) => factText(fact).includes(keyword)));
    const score = evidence.reduce((total, fact) => total + entry.keywords.filter((keyword) => factText(fact).includes(keyword)).length, 0);
    return { entry, index, score, evidence };
  });
  const directMatches = scored.filter(({ evidence }) => evidence.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const adjacentDirections = scored.filter(({ evidence }) => !evidence.length)
    .slice(0, Math.max(0, 3 - directMatches.length));

  return [
    ...directMatches.map(({ entry, evidence }) => ({
      suggestionId: entry.id,
      roleFamily: entry.roleFamily,
      rationale: `当前可信画像事实显示你具备与${entry.roleFamily}相关的经验和技能。`,
      evidence: evidence.map((fact) => ({
        factId: fact.factId,
        revisionId: fact.revisionId,
        label: factLabel(fact),
      })),
    })),
    ...adjacentDirections.map(({ entry }) => ({
      suggestionId: entry.id,
      roleFamily: entry.roleFamily,
      rationale: `当前可信画像事实尚未直接证明你符合${entry.roleFamily}；这是基于现有技术背景给出的相邻方向，请你确认。`,
      evidence: facts.map((fact) => ({
        factId: fact.factId,
        revisionId: fact.revisionId,
        label: factLabel(fact),
      })),
    })),
  ];
}

type TargetDatabase = Pick<Database, "insert" | "select" | "update">;

async function currentTargets(db: TargetDatabase, userId: string, activeOnly = false): Promise<JobTarget[]> {
  const rows = await db.select({
    targetId: jobTargets.id,
    version: jobTargets.version,
    priority: jobTargets.priority,
    state: jobTargets.state,
    constraints: jobTargetRevisions.constraints,
    createdAt: jobTargets.createdAt,
    updatedAt: jobTargets.updatedAt,
  }).from(jobTargets).innerJoin(jobTargetRevisions, and(
    eq(jobTargetRevisions.userId, jobTargets.userId),
    eq(jobTargetRevisions.targetId, jobTargets.id),
    eq(jobTargetRevisions.version, jobTargets.version),
  )).where(and(
    eq(jobTargets.userId, userId),
    ...(activeOnly ? [eq(jobTargets.state, "active")] : []),
  )).orderBy(asc(jobTargets.createdAt));

  return rows.map((row) => JobTargetSchema.parse({
    ...row,
    constraints: JobTargetConstraintsSchema.parse(row.constraints),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function overview(db: Database, userId: string): Promise<JobTargetOverview> {
  const facts = await createTrustedProfileQueries({ db }).getCurrent({ userId });
  return JobTargetOverviewSchema.parse({
    suggestions: suggestJobTargetDirections(facts.facts),
    targets: await currentTargets(db, userId),
  });
}

async function activeSlots(db: TargetDatabase, userId: string) {
  return db.select({ id: jobTargets.id, priority: jobTargets.priority, activeSlot: jobTargets.activeSlot })
    .from(jobTargets).where(and(eq(jobTargets.userId, userId), eq(jobTargets.state, "active")));
}

function secondarySlot(rows: { id: string; priority: string; activeSlot: number | null }[], excludingTargetId?: string): number {
  const occupied = new Set(rows.filter((row) => row.id !== excludingTargetId && row.priority === "secondary")
    .map((row) => row.activeSlot));
  const slot = [1, 2].find((candidate) => !occupied.has(candidate));
  if (!slot) throw new JobTargetError("JOB_TARGET_SECONDARY_LIMIT");
  return slot;
}

function assertPriorityCapacity(rows: { id: string; priority: string }[], priority: "primary" | "secondary", excludingTargetId?: string) {
  const count = rows.filter((row) => row.id !== excludingTargetId && row.priority === priority).length;
  if (priority === "primary" && count >= 1) throw new JobTargetError("JOB_TARGET_PRIMARY_LIMIT");
  if (priority === "secondary" && count >= 2) throw new JobTargetError("JOB_TARGET_SECONDARY_LIMIT");
}

type Dependencies = { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date };

export function createJobTargetQueries(deps: { db: Database }): {
  getOverview(input: { userId: string }): Promise<JobTargetOverview>;
  getActive(input: { userId: string }): Promise<JobTarget[]>;
} {
  return {
    getOverview: ({ userId }) => overview(deps.db, userId),
    getActive: ({ userId }) => currentTargets(deps.db, userId, true),
  };
}

export function createJobTargetCommands(deps: Dependencies): {
  create(input: { userId: string; requestId: string; command: CreateJobTargetCommand }): Promise<JobTargetOverview>;
  revise(input: { userId: string; requestId: string; targetId: string; command: ReviseJobTargetCommand }): Promise<JobTargetOverview>;
  deactivate(input: { userId: string; requestId: string; targetId: string; command: DeactivateJobTargetCommand }): Promise<JobTargetOverview>;
} {
  return {
    async create(input) {
      const command = CreateJobTargetCommandSchema.parse(input.command);
      await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const active = await activeSlots(transaction, input.userId);
        assertPriorityCapacity(active, command.priority);
        const targetId = deps.id();
        const version = 1;
        const createdAt = deps.clock();
        const activeSlot = command.priority === "secondary" ? secondarySlot(active) : null;
        await transaction.insert(jobTargets).values({
          id: targetId, userId: input.userId, version, priority: command.priority, state: "active", activeSlot, createdAt, updatedAt: createdAt,
        });
        await transaction.insert(jobTargetRevisions).values({
          id: deps.id(), userId: input.userId, targetId, version, priority: command.priority, state: "active", constraints: command.constraints, createdAt,
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.job_target_maintained", occurredAt: createdAt,
          requestId: input.requestId, outcome: "success", reasonCode: "JOB_TARGET_CREATED", resourceType: "job_target", resourceId: targetId,
          metadata: { targetId, action: "created", version, priority: command.priority, state: "active" },
        });
      });
      return overview(deps.db, input.userId);
    },
    async revise(input) {
      const command = ReviseJobTargetCommandSchema.parse(input.command);
      await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [current] = await transaction.select({
          version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, activeSlot: jobTargets.activeSlot,
        }).from(jobTargets).where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId)));
        if (!current) throw new JobTargetError("JOB_TARGET_NOT_FOUND");
        if (current.version !== command.expectedVersion) throw new JobTargetError("JOB_TARGET_VERSION_CONFLICT");
        const active = current.state === "active" ? await activeSlots(transaction, input.userId) : [];
        if (current.state === "active" && current.priority !== command.priority) assertPriorityCapacity(active, command.priority, input.targetId);
        const activeSlot = current.state !== "active" || command.priority === "primary" ? null
          : current.priority === "secondary" ? current.activeSlot : secondarySlot(active, input.targetId);
        const updatedAt = deps.clock();
        const [updated] = await transaction.update(jobTargets).set({
          version: sql`${jobTargets.version} + 1`, priority: command.priority, activeSlot, updatedAt,
        }).where(and(
          eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId), eq(jobTargets.version, command.expectedVersion),
        )).returning({ version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state });
        if (!updated) throw new JobTargetError("JOB_TARGET_VERSION_CONFLICT");
        await transaction.insert(jobTargetRevisions).values({
          id: deps.id(), userId: input.userId, targetId: input.targetId, version: updated.version, priority: updated.priority,
          state: updated.state, constraints: command.constraints, createdAt: updatedAt,
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.job_target_maintained", occurredAt: updatedAt,
          requestId: input.requestId, outcome: "success", reasonCode: "JOB_TARGET_REVISED", resourceType: "job_target", resourceId: input.targetId,
          metadata: { targetId: input.targetId, action: "revised", version: updated.version, priority: updated.priority as "primary" | "secondary", state: updated.state as "active" | "inactive" },
        });
      });
      return overview(deps.db, input.userId);
    },
    async deactivate(input) {
      const command = DeactivateJobTargetCommandSchema.parse(input.command);
      await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [current] = await transaction.select({
          version: jobTargets.version, priority: jobTargets.priority, constraints: jobTargetRevisions.constraints,
        }).from(jobTargets).innerJoin(jobTargetRevisions, and(
          eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version),
        )).where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId)));
        if (!current) throw new JobTargetError("JOB_TARGET_NOT_FOUND");
        if (current.version !== command.expectedVersion) throw new JobTargetError("JOB_TARGET_VERSION_CONFLICT");
        const updatedAt = deps.clock();
        const [updated] = await transaction.update(jobTargets).set({
          version: sql`${jobTargets.version} + 1`, state: "inactive", activeSlot: null, updatedAt,
        }).where(and(
          eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId), eq(jobTargets.version, command.expectedVersion),
        )).returning({ version: jobTargets.version });
        if (!updated) throw new JobTargetError("JOB_TARGET_VERSION_CONFLICT");
        await transaction.insert(jobTargetRevisions).values({
          id: deps.id(), userId: input.userId, targetId: input.targetId, version: updated.version, priority: current.priority,
          state: "inactive", constraints: JobTargetConstraintsSchema.parse(current.constraints), createdAt: updatedAt,
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.job_target_maintained", occurredAt: updatedAt,
          requestId: input.requestId, outcome: "success", reasonCode: "JOB_TARGET_DEACTIVATED", resourceType: "job_target", resourceId: input.targetId,
          metadata: { targetId: input.targetId, action: "deactivated", version: updated.version, priority: current.priority as "primary" | "secondary", state: "inactive" },
        });
      });
      return overview(deps.db, input.userId);
    },
  };
}

export type JobTargetCommands = ReturnType<typeof createJobTargetCommands>;
export type JobTargetQueries = ReturnType<typeof createJobTargetQueries>;
