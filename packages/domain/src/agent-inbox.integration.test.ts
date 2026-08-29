import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentInboxItemActions, agentInboxItems, agentRunEvents, agentRuns, createDatabase, jobAccounts, jobTargetRevisions, jobTargets, migrateDatabase, type Database } from "@job-copilot/database";
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

  async function openItem(input: { userId: string; targetId: string; kind: "decision_required" | "run_failed" | "budget_exhausted"; reasonCode: "AGENT_RUN_PAUSED" | "AGENT_RUN_ADAPTER_FAILED" | "AGENT_RUN_BUDGET_EXCEEDED"; budgetDimension?: "tool_calls" }) {
    const run = await commands().start({ userId: input.userId, requestId: crypto.randomUUID(), command: { targetId: input.targetId, idempotencyKey: crypto.randomUUID() } });
    if (input.kind === "decision_required") await database.update(agentRuns).set({ status: "paused" }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const itemId = crypto.randomUUID();
    await database.insert(agentInboxItems).values({ id: itemId, userId: input.userId, runId: run.runId, triggerEventSequence: 1, kind: input.kind, status: "open", reasonCode: input.reasonCode, budgetDimension: input.budgetDimension ?? null, createdAt: now });
    return { itemId, runId: run.runId };
  }

  it("只向 owner 投影固定的 open Inbox 项及其可用动作", async () => {
    const owner = await activeTarget();
    const other = await activeTarget();
    await openItem({ ...owner, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED" });
    await openItem({ ...owner, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" });
    await openItem({ ...owner, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" });

    await expect(inbox().list({ userId: owner.userId, status: "open" })).resolves.toEqual({ items: expect.arrayContaining([
      expect.objectContaining({ kind: "decision_required", availableActions: ["resume_run", "cancel_run"], title: "岗位发现已暂停", targetHref: null }),
      expect.objectContaining({ kind: "run_failed", availableActions: ["restart_run", "dismiss"], title: "岗位发现未完成", targetHref: null }),
      expect.objectContaining({ kind: "budget_exhausted", availableActions: ["dismiss"], targetHref: "/profile/targets" }),
    ]) });
    await expect(inbox().list({ userId: other.userId, status: "open" })).resolves.toEqual({ items: [] });
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
    const action = { userId: owner.userId, requestId: crypto.randomUUID(), itemId: failed.itemId, command: { actionId, action: "restart_run" as const } };
    await expect(inbox().act(action)).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(inbox().act({ ...action, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AGENT_INBOX_ACTION_FAILED" });
    await expect(database.select({ outcome: agentInboxItemActions.outcome, reasonCode: agentInboxItemActions.reasonCode }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, owner.userId), eq(agentInboxItemActions.itemId, failed.itemId), eq(agentInboxItemActions.actionId, actionId)))).resolves.toEqual([{ outcome: "failed", reasonCode: "AGENT_INBOX_ACTION_FAILED" }]);
    await expect(inbox().list({ userId: owner.userId, status: "open" })).resolves.toMatchObject({ items: [expect.objectContaining({ itemId: failed.itemId, status: "open" })] });
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
