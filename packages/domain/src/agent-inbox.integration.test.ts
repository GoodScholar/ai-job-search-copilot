import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItemActions, agentInboxItems, agentRunEvents, agentRuns, auditEvents, calibrationProposals, candidateFacts, careerDocuments, careerImports, createDatabase, jobAccounts, jobSourceHealthChecks, jobTargetRevisions, jobTargets, migrateDatabase, recommendationLists, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentInbox, createAgentRunCommands, type AgentRunQueue } from "./agent-runs";

const now = new Date("2026-08-29T12:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};

class MemoryQueue implements AgentRunQueue {
  readonly jobs: Array<{ version: 1; runId: string; userId: string }> = [];
  async enqueue(job: { version: 1; runId: string; userId: string }) { this.jobs.push(job); }
}

describe("agent inbox", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function activeTarget(userId = crypto.randomUUID()) {
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    return { userId, targetId };
  }

  const queue = new MemoryQueue();
  const commands = () => createAgentRunCommands({ db: database, queue, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  const inbox = () => createAgentInbox({ db: database, commands: commands(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

  async function openItem(input: { userId: string; targetId: string; kind: "decision_required" | "run_failed" | "budget_exhausted" | "source_attention"; reasonCode: "AGENT_RUN_PAUSED" | "AGENT_RUN_ADAPTER_FAILED" | "AGENT_RUN_BUDGET_EXCEEDED" | "SOURCE_HEALTH_ATTENTION"; budgetDimension?: "tool_calls" }) {
    const run = await commands().start({ userId: input.userId, requestId: crypto.randomUUID(), command: { targetId: input.targetId, idempotencyKey: crypto.randomUUID() } });
    if (input.kind === "decision_required") await database.update(agentRuns).set({ status: "paused" }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const itemId = crypto.randomUUID();
    const watchlistItemId = input.kind === "source_attention" ? crypto.randomUUID() : null;
    const sourceHealthCheckId = input.kind === "source_attention" ? crypto.randomUUID() : null;
    if (watchlistItemId && sourceHealthCheckId) {
      await database.insert(jobSourceHealthChecks).values({
        id: sourceHealthCheckId, userId: input.userId, runId: run.runId, targetId: input.targetId, watchlistItemId,
        sourceId: `greenhouse:inbox-${itemId.replaceAll("-", "")}`,
        status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null,
        observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: now,
      });
    }
    await database.insert(agentInboxItems).values({ id: itemId, userId: input.userId, runId: run.runId, triggerEventSequence: 1, watchlistItemId, sourceHealthCheckId, kind: input.kind, status: "unread", reasonCode: input.reasonCode, budgetDimension: input.budgetDimension ?? null, createdAt: now });
    return { itemId, runId: run.runId, watchlistItemId };
  }

  it("只向 owner 投影固定的 unread Inbox 项及其可用动作", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    await openItem({ ...owner, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED" });
    await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });

    const result = await inbox().list({ userId: owner.userId, status: "pending" });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "decision_required", availableActions: ["resume_run", "cancel_run"], title: "岗位发现已暂停", target: expect.objectContaining({ type: "agent_run" }) }),
      expect.objectContaining({ kind: "run_failed", availableActions: ["restart_run", "dismiss"], title: "岗位发现未完成", target: expect.objectContaining({ type: "agent_run" }) }),
      expect.objectContaining({ kind: "budget_exhausted", availableActions: ["dismiss"], target: expect.objectContaining({ type: "agent_run" }) }),
    ]));
    await expect(inbox().list({ userId: other.userId, status: "pending" })).resolves.toEqual({ items: [] });
  });

  it("为来源关注项从 owner-bound run 投影精确诊断链接，并以 actionId 幂等 dismiss", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    const item = await openItem({ ...owner, kind: "source_attention", reasonCode: "SOURCE_HEALTH_ATTENTION" });
    await expect(inbox().list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [expect.objectContaining({
      itemId: item.itemId, kind: "source_attention", availableActions: ["dismiss"],
      target: { type: "job_source", watchlistItemId: item.watchlistItemId, targetId: owner.targetId, href: `/profile/targets/${owner.targetId}/watchlist#source-health` },
    })] });
    await expect(inbox().list({ userId: other.userId, status: "pending" })).resolves.toEqual({ items: [] });
    const actionId = crypto.randomUUID();
    const first = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId, action: "dismiss" } });
    const replay = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId, action: "dismiss" } });
    expect(first).toMatchObject({ applied: true, item: { status: "resolved", availableActions: [], target: { type: "job_source", targetId: owner.targetId } }, run: null });
    expect(replay).toEqual(first);
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, item.itemId)))).resolves.toHaveLength(1);
  });

  it("mark_read 将 unread 事项转为 read，允许后续 dismiss，并按 actionId 重放", async () => {
    const owner = await activeTarget();
    const item = await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });
    const actionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const first = await inbox().act({ userId: owner.userId, requestId, itemId: item.itemId, command: { actionId, action: "mark_read" } });
    const replay = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId, action: "mark_read" } });

    expect(first).toMatchObject({ applied: true, item: { status: "read", readAt: now.toISOString(), resolvedAt: null, availableActions: ["dismiss"] }, run: null });
    expect(replay).toEqual(first);
    await expect(database.select({ requestId: auditEvents.requestId, metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.userId, owner.userId), eq(auditEvents.resourceId, item.itemId), eq(auditEvents.eventType, "agent.inbox_action_applied")))).resolves.toEqual([expect.objectContaining({ requestId, metadata: expect.objectContaining({ action: "mark_read", outcome: "applied" }) })]);
    await expect(inbox().list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [expect.objectContaining({ itemId: item.itemId, status: "read" })] });
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId: crypto.randomUUID(), action: "dismiss" } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" } });
  });

  it("已被 dismiss 解决的中断 mark_read action 会原子结算为 no_change", async () => {
    const owner = await activeTarget();
    const item = await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });
    const markReadActionId = crypto.randomUUID();
    await database.insert(agentInboxItemActions).values({ id: crypto.randomUUID(), userId: owner.userId, itemId: item.itemId, actionId: markReadActionId, action: "mark_read", outcome: "pending", relatedRunId: null, reasonCode: null, createdAt: now });
    await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId: crypto.randomUUID(), action: "dismiss" } });

    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId: markReadActionId, action: "mark_read" } })).resolves.toMatchObject({ applied: false, item: { status: "resolved" } });
    await expect(database.select({ outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, item.itemId), eq(agentInboxItemActions.actionId, markReadActionId)))).resolves.toEqual([{ outcome: "no_change" }]);
  });

  it("pending 合并 unread 和 read，并以 createdAt、itemId 稳定地从新到旧排序", async () => {
    const owner = await activeTarget();
    const older = await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    const newerId = crypto.randomUUID();
    await database.insert(agentInboxItems).values({
      id: newerId, userId: owner.userId, runId: older.runId, triggerEventSequence: 2, kind: "discovery_attention",
      status: "read", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: new Date("2026-08-29T13:00:00.000Z"), readAt: new Date("2026-08-29T13:00:00.000Z"),
    });
    await expect(inbox().list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [
      expect.objectContaining({ itemId: newerId, status: "read" }),
      expect.objectContaining({ itemId: older.itemId, status: "unread" }),
    ] });
  });

  it("相同 createdAt 的 pending 项按 itemId 倒序稳定排序，且同一 actionId 不可改作另一动作", async () => {
    const owner = await activeTarget();
    const first = await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    const second = await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });
    const listed = await inbox().list({ userId: owner.userId, status: "pending" });
    expect(listed.items.map((item) => item.itemId)).toEqual([first.itemId, second.itemId].sort().reverse());
    const actionId = crypto.randomUUID();
    await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: first.itemId, command: { actionId, action: "mark_read" } });
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: first.itemId, command: { actionId, action: "dismiss" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_CONFLICT" });
  });

  it("从 owner-bound candidate fact、recommendation list 与 calibration proposal 投影安全 typed target 和说明", async () => {
    const owner = await activeTarget();
    const documentId = crypto.randomUUID(); const importId = crypto.randomUUID(); const factId = crypto.randomUUID(); const listId = crypto.randomUUID(); const proposalId = crypto.randomUUID();
    await database.insert(careerDocuments).values({ id: documentId, userId: owner.userId, checksumSha256: "a".repeat(64), objectKey: `accounts/${owner.userId}/source.md`, originalFilename: "source.md", mediaType: "text/markdown", byteSize: 1 });
    await database.insert(careerImports).values({ id: importId, userId: owner.userId, careerDocumentId: documentId, originatingRequestId: crypto.randomUUID() });
    await database.insert(candidateFacts).values({ id: factId, userId: owner.userId, careerImportId: importId, careerDocumentId: documentId, factKey: "b".repeat(64), factType: "skill", factValue: { name: "private skill" }, confidenceBasisPoints: 9000, createdAt: now });
    await database.insert(recommendationLists).values({ id: listId, userId: owner.userId, targetId: owner.targetId, localDate: "2026-08-29", sequence: 1, createdAt: now });
    await database.insert(calibrationProposals).values({ id: proposalId, userId: owner.userId, targetId: owner.targetId, reason: "SALARY", status: "pending", version: 1, createdAt: now, updatedAt: now });
    await database.insert(agentInboxItems).values([
      { id: crypto.randomUUID(), userId: owner.userId, runId: null, triggerEventSequence: null, candidateFactId: factId, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null, createdAt: now },
      { id: crypto.randomUUID(), userId: owner.userId, runId: null, triggerEventSequence: null, recommendationListId: listId, kind: "recommendation_list", status: "unread", reasonCode: "RECOMMENDATION_LIST_PUBLISHED", budgetDimension: null, createdAt: now },
      { id: crypto.randomUUID(), userId: owner.userId, runId: null, triggerEventSequence: null, calibrationProposalId: proposalId, kind: "calibration_proposal", status: "unread", reasonCode: "CALIBRATION_PROPOSAL_CREATED", budgetDimension: null, createdAt: now },
    ]);
    const items = (await inbox().list({ userId: owner.userId, status: "pending" })).items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "candidate_fact", target: expect.objectContaining({ type: "candidate_fact", candidateFactId: factId }), basis: expect.any(String), impact: expect.any(String), suggestedAction: expect.any(String) }),
      expect.objectContaining({ kind: "recommendation_list", target: expect.objectContaining({ type: "recommendation_list", recommendationListId: listId, targetId: owner.targetId }), basis: expect.any(String), impact: expect.any(String), suggestedAction: expect.any(String) }),
      expect.objectContaining({ kind: "calibration_proposal", target: expect.objectContaining({ type: "calibration_proposal", proposalId, targetId: owner.targetId }), basis: expect.any(String), impact: expect.any(String), suggestedAction: expect.any(String) }),
    ]));
    expect(JSON.stringify(items)).not.toContain("private skill");
  });

  it("恢复或取消 decision 项时只执行允许的控制并解决项，重放不重复审计或事件", async () => {
    const owner = await activeTarget();
    const { itemId, runId } = await openItem({ ...owner, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED" });
    const actionId = crypto.randomUUID();
    const first = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId, action: "resume_run" } });
    const replay = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId, action: "resume_run" } });

    expect(first).toMatchObject({ applied: true, item: { status: "resolved", availableActions: [] }, run: { runId, status: "queued" } });
    expect(replay).toEqual(first);
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, itemId)))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, owner.userId), eq(agentRunEvents.runId, runId), eq(agentRunEvents.eventType, "run.resumed")))).resolves.toHaveLength(1);
    await expect(database.select({ eventType: auditEvents.eventType, requestId: auditEvents.requestId, outcome: auditEvents.outcome, metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.userId, owner.userId), eq(auditEvents.resourceId, itemId), eq(auditEvents.eventType, "agent.inbox_action_applied")))).resolves.toEqual([expect.objectContaining({ eventType: "agent.inbox_action_applied", outcome: "success", metadata: expect.objectContaining({ action: "resume_run", outcome: "applied" }) })]);
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId: crypto.randomUUID(), action: "dismiss" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_CONFLICT" });
  });

  it("restart 使用当前 active target 版本、保存 retry 关联并以 actionId 重放", async () => {
    const owner = await activeTarget();
    const { itemId, runId } = await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed", usageComplete: true }).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.id, runId)));
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: owner.userId, targetId: owner.targetId, version: 2, priority: "primary", state: "active", constraints, createdAt: now });
    await database.update(jobTargets).set({ version: 2, updatedAt: now }).where(and(eq(jobTargets.userId, owner.userId), eq(jobTargets.id, owner.targetId)));
    const actionId = crypto.randomUUID();
    const first = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId, action: "restart_run" } });
    const replay = await inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId, action: "restart_run" } });

    expect(first).toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
    expect(replay).toEqual(first);
    const runs = await database.select().from(agentRuns).where(eq(agentRuns.userId, owner.userId));
    expect(runs.filter((run) => run.retryOfRunId === runId)).toEqual([expect.objectContaining({ targetVersion: 2 })]);
  });

  it("拒绝跨账户、非法动作，并让 dismiss 解决失败或预算事项", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    const budget = await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });
    await expect(inbox().act({ userId: other.userId, requestId: crypto.randomUUID(), itemId: budget.itemId, command: { actionId: crypto.randomUUID(), action: "dismiss" } })).rejects.toMatchObject({ code: "AGENT_INBOX_NOT_FOUND" });
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: budget.itemId, command: { actionId: crypto.randomUUID(), action: "restart_run" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_CONFLICT" });
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: budget.itemId, command: { actionId: crypto.randomUUID(), action: "dismiss" } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" }, run: null });
  });

  it("启动重试失败时记录 failed outcome 并保持失败事项开放", async () => {
    const owner = await activeTarget();
    const failed = await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed", usageComplete: true }).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.id, failed.runId)));
    await database.update(jobTargets).set({ state: "inactive", activeSlot: null }).where(and(eq(jobTargets.userId, owner.userId), eq(jobTargets.id, owner.targetId)));
    const actionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const action = { userId: owner.userId, requestId, itemId: failed.itemId, command: { actionId, action: "restart_run" as const } };
    await expect(inbox().act(action)).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(inbox().act({ ...action, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(database.select({ outcome: agentInboxItemActions.outcome, reasonCode: agentInboxItemActions.reasonCode }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, failed.itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toEqual([{ outcome: "failed", reasonCode: "AGENT_INBOX_ACTION_FAILED" }]);
    await expect(database.select({ eventType: auditEvents.eventType, requestId: auditEvents.requestId, outcome: auditEvents.outcome, reasonCode: auditEvents.reasonCode, metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.userId, owner.userId), eq(auditEvents.resourceId, failed.itemId), eq(auditEvents.eventType, "agent.inbox_action_applied")))).resolves.toEqual([expect.objectContaining({ eventType: "agent.inbox_action_applied", requestId, outcome: "failure", reasonCode: "AGENT_INBOX_ACTION_FAILED", metadata: expect.objectContaining({ action: "restart_run", outcome: "failed", reasonCode: "AGENT_INBOX_ACTION_FAILED" }) })]);
    await expect(inbox().list({ userId: owner.userId, status: "pending" })).resolves.toMatchObject({ items: [expect.objectContaining({ itemId: failed.itemId, status: "unread" })] });
    await database.update(jobTargets).set({ state: "active" }).where(and(eq(jobTargets.userId, owner.userId), eq(jobTargets.id, owner.targetId)));
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: failed.itemId, command: { actionId: crypto.randomUUID(), action: "restart_run" } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" }, run: { status: "queued" } });
  });

  it("恢复控制失败时记录失败审计并允许使用新 actionId 重试", async () => {
    const owner = await activeTarget();
    const item = await openItem({ ...owner, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED" });
    const actionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const commandService = commands();
    const failingInbox = createAgentInbox({
      db: database,
      commands: { start: commandService.start, async control() { throw new Error("control unavailable"); } },
      auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(failingInbox.act({ userId: owner.userId, requestId, itemId: item.itemId, command: { actionId, action: "resume_run" } })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(database.select({ outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, item.itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toEqual([{ outcome: "failed" }]);
    await expect(database.select({ requestId: auditEvents.requestId, outcome: auditEvents.outcome, metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.userId, owner.userId), eq(auditEvents.resourceId, item.itemId), eq(auditEvents.eventType, "agent.inbox_action_applied")))).resolves.toEqual([expect.objectContaining({ requestId, outcome: "failure", metadata: expect.objectContaining({ action: "resume_run", outcome: "failed" }) })]);
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: item.itemId, command: { actionId: crypto.randomUUID(), action: "resume_run" } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" } });
  });

  it("新运行已创建但解决事项失败时重放复用该运行并完成解决", async () => {
    const owner = await activeTarget();
    const failed = await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    await database.update(agentRuns).set({ status: "failed", currentStep: "failed", startedAt: now, failedAt: now, failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed", usageComplete: true }).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.id, failed.runId)));
    const actionId = crypto.randomUUID();
    const reliableAudit = createAuditTrail({ db: database, clock: () => now });
    let failResolution = true;
    const flakyAudit = {
      ...reliableAudit,
      bind(transaction: Database) {
        const bound = reliableAudit.bind(transaction);
        return {
          ...bound,
          async append(event: Parameters<typeof bound.append>[0]) {
            if (failResolution && event.eventType === "agent.inbox_resolved") {
              failResolution = false;
              throw new Error("resolution audit unavailable");
            }
            await bound.append(event);
          },
        };
      },
    };
    const firstInbox = createAgentInbox({ db: database, commands: commands(), auditTrail: flakyAudit, id: () => crypto.randomUUID(), clock: () => now });
    await expect(firstInbox.act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: failed.itemId, command: { actionId, action: "restart_run" } })).rejects.toThrow("resolution audit unavailable");
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, actionId)))).resolves.toHaveLength(1);
    await expect(inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId: failed.itemId, command: { actionId, action: "restart_run" } })).resolves.toMatchObject({ applied: true, item: { status: "resolved" } });
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, owner.userId), eq(agentRuns.idempotencyKey, actionId)))).resolves.toHaveLength(1);
  });

  it("同一 open 事项的不同 action 并发时，至多一个命令获得 durable ownership", async () => {
    const owner = await activeTarget();
    const { itemId } = await openItem({ ...owner, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED" });
    const [resume, cancel] = await Promise.allSettled([
      inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId: crypto.randomUUID(), action: "resume_run" } }),
      inbox().act({ userId: owner.userId, requestId: crypto.randomUUID(), itemId, command: { actionId: crypto.randomUUID(), action: "cancel_run" } }),
    ]);
    expect([resume, cancel].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(database.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, itemId)))).resolves.toHaveLength(1);
    await expect(database.select({ status: agentInboxItems.status }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, owner.userId), eq(agentInboxItems.id, itemId)))).resolves.toEqual([{ status: "resolved" }]);
  });
});
