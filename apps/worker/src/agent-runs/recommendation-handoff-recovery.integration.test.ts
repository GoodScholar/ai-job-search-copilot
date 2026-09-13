import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRunEvents,
  agentRuns,
  createDatabase,
  jobAccounts,
  jobProfiles,
  jobTargetRevisions,
  jobTargets,
  migrateDatabase,
  modelDiagnosticResults,
  profileFactRevisions,
  profileFacts,
  type Database,
} from "@job-copilot/database";
import {
  createAgentRunCheckpoint,
  createAgentRunProcessor,
  createAgentRunRecoveryQueries,
} from "@job-copilot/domain/agent-runs";
import { createAccountRunControl } from "@job-copilot/domain/account-run-control";
import { createAuditTrail } from "@job-copilot/domain/audit-trail";
import { createModelDiagnosticProjectionReader } from "@job-copilot/domain/model-diagnostics";
import { createRecommendationRunCommands } from "@job-copilot/domain/recommendation-runs";
import { createRunPreflightEvaluator } from "@job-copilot/domain/run-preflight";

import { AgentRunReconciler } from "./agent-run-reconciler.js";

const now = new Date("2026-09-13T00:00:00.000Z");
const constraints = {
  roleFamily: "AI 应用工程师",
  seniority: null,
  locations: [],
  workModes: [],
  relocation: "unknown" as const,
  salary: null,
  industries: [],
  dealBreakers: {
    excludedCompanies: [],
    excludedIndustries: [],
    excludeOutsourcing: false,
    excludeDispatch: false,
    excludeHeadhunter: false,
    other: [],
  },
};

describe("推荐 handoff 的 Worker 恢复", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(postgres.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await postgres?.stop();
  });

  it("真实恢复查询只补发已持久化的 recommendation child，停止后不再补发", async () => {
    const userId = randomUUID();
    const targetId = randomUUID();
    const profileId = randomUUID();
    const factId = randomUUID();
    const fingerprint = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({
      id: targetId,
      userId,
      version: 1,
      priority: "primary",
      state: "active",
      activeSlot: null,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(jobTargetRevisions).values({
      id: randomUUID(),
      userId,
      targetId,
      version: 1,
      priority: "primary",
      state: "active",
      constraints,
      createdAt: now,
    });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({
      id: randomUUID(),
      userId,
      profileFactId: factId,
      revisionNumber: 1,
      factType: "skill",
      factValue: { name: "TypeScript" },
      state: "active",
      source: "user_confirmed",
      candidateFactId: null,
      reason: null,
      profileVersion: 1,
      createdAt: now,
    });
    await database.insert(modelDiagnosticResults).values({
      configurationFingerprint: fingerprint,
      status: "available",
      checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" },
      reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE",
      latencyBucket: "under_1s",
      checkedAt: now,
    });

    const preflight = createRunPreflightEvaluator({
      capabilityAdapter: {
        adapter: "greenhouse",
        adapterVersion: "test",
        declareCapabilities: ({ sourceId }) => ({
          sourceId,
          adapter: "greenhouse",
          adapterVersion: "test",
          contractVersion: "source-capabilities-v1",
          capabilities: ["active_discovery", "read_details", "continuous_monitoring"],
        }),
      },
      modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }),
      discoveryExecutionMode: "layered_public",
      id: randomUUID,
      clock: () => now,
    });
    const started = await createRecommendationRunCommands({
      db: database,
      queue: { enqueue: async () => undefined },
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      runPreflight: preflight,
      executionMode: "layered_public",
      id: randomUUID,
      clock: () => now,
    }).start({
      userId,
      requestId: randomUUID(),
      command: {
        idempotencyKey: randomUUID(),
        warningFingerprint: (await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" })).report.warningFingerprint,
      },
    });

    const matchingAttempted: string[] = [];
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("layered root does not resolve a direct discovery adapter"); } },
      layeredPublicWorkflowResolver: {
        resolve: (input) => ({
          run: async () => ({
            branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const },
            diagnostics: [],
            discoveryFacts: {
              version: "recommendation-discovery-facts-v1" as const,
              trusted: input.executionSpec.sourceScope.trustedSources.map(({ source }) => ({ sourceId: source.sourceId, checked: true as const, outcome: "credible_zero" as const, losses: [] })),
              publicQueries: input.executionSpec.sourceScope.publicDiscovery.queries.map((query) => ({ queryId: query.queryId, checked: true as const, outcome: "credible_zero" as const, losses: [] })),
            },
          }),
        }),
      },
      checkpoint: createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now }),
      contentStore: { put: async () => undefined, delete: async () => undefined },
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      matchingQueue: {
        enqueue: async (job) => {
          matchingAttempted.push(job.runId);
          throw new Error("matching queue unavailable");
        },
      },
      id: randomUUID,
      clock: () => now,
      runPreflight: preflight,
    });
    await expect(processor.process({ version: 1, userId, runId: started.run.runId, finalAttempt: true })).resolves.toBe("completed");

    const [child] = await database.select({ id: agentRuns.id, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.parentRunId, started.run.runId)));
    expect(child).toEqual(expect.objectContaining({ status: "queued" }));
    if (!child) throw new Error("persisted recommendation child is missing");
    expect(matchingAttempted).toEqual([child.id]);

    const beforeRecovery = await Promise.all([
      database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.userId, userId)),
      database.select({ id: agentRunEvents.id }).from(agentRunEvents)
        .where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, child.id), eq(agentRunEvents.eventType, "run.queued"))),
    ]);
    expect(beforeRecovery).toEqual([[expect.any(Object), expect.any(Object)], [expect.any(Object)]]);

    const recovered: Array<{ version: number; runId: string; userId: string }> = [];
    const failures: unknown[] = [];
    let reconciler: AgentRunReconciler | undefined;
    try {
      reconciler = new AgentRunReconciler({
        recoveryQueries: createAgentRunRecoveryQueries({ db: database, clock: () => now }),
        queue: { enqueue: async (job) => { recovered.push(job); } },
        reporter: { report: async (failure) => { failures.push(failure); } },
      });
      await reconciler.onModuleInit();
    } finally {
      await reconciler?.close();
    }
    expect(recovered).toEqual([{ version: 1, runId: child.id, userId }]);
    expect(failures).toEqual([]);
    await expect(Promise.all([
      database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.userId, userId)),
      database.select({ id: agentRunEvents.id }).from(agentRunEvents)
        .where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, child.id), eq(agentRunEvents.eventType, "run.queued"))),
    ])).resolves.toEqual(beforeRecovery);

    await expect(createAccountRunControl({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: randomUUID,
      clock: () => now,
    }).control({
      userId,
      requestId: randomUUID(),
      command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" },
    })).resolves.toMatchObject({ applied: true });
    await expect(database.select({ status: agentRuns.status }).from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, child.id))))
      .resolves.toEqual([{ status: "paused" }]);

    const afterStop: Array<{ version: number; runId: string; userId: string }> = [];
    let stoppedReconciler: AgentRunReconciler | undefined;
    try {
      stoppedReconciler = new AgentRunReconciler({
        recoveryQueries: createAgentRunRecoveryQueries({ db: database, clock: () => now }),
        queue: { enqueue: async (job) => { afterStop.push(job); } },
        reporter: { report: async (failure) => { failures.push(failure); } },
      });
      await stoppedReconciler.onModuleInit();
    } finally {
      await stoppedReconciler?.close();
    }
    expect(afterStop).toEqual([]);
    expect(failures).toEqual([]);
  }, 60_000);
});
