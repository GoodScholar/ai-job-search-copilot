import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, jobAccounts, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";

const userId = "8cf9ef56-08fd-4465-b4c7-4c713d0d80a5";
const requestId = "adfbd5ec-4b3a-4b63-af71-f1635205704c";
const now = new Date("2026-08-26T12:00:00.000Z");

describe("audit trail", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    await database.insert(jobAccounts).values({ id: userId });
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("rejects metadata outside the event-specific allowlist instead of storing it", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await expect(auditTrail.append({
      userId,
      eventType: "auth.session_started",
      outcome: "success",
      requestId,
      reasonCode: "AUTH_SESSION_STARTED",
      resourceType: "session",
      metadata: { sessionToken: "must-not-be-stored" } as never,
    })).rejects.toThrow(/字段白名单/);
  });

  it("accepts only the metadata shape assigned to each approved event", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });

    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      resourceType: "session",
      metadata: { provider: "dev" },
    });

    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_ended",
      outcome: "success",
      reasonCode: "AUTH_SESSION_ENDED",
      requestId: "2d5d9ef3-0b02-4514-9f1a-7cda8e3f1736",
      resourceType: "session",
      metadata: {},
    });
    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "auth.session_rejected",
      outcome: "denied",
      reasonCode: "AUTH_SESSION_REVOKED",
      requestId: "54b36840-180d-4344-87c1-f414f79ef70b",
      resourceType: "session",
      metadata: {},
    });
    await auditTrail.append({
      userId,
      actorUserId: userId,
      eventType: "account.access_rejected",
      outcome: "denied",
      reasonCode: "ACCOUNT_NOT_FOUND",
      requestId: "b9bbd306-e072-4e86-9019-6c49d3d0f751",
      resourceType: "account",
      resourceId: "b016711c-9834-43d6-a3cb-859880710b61",
      metadata: {},
    });

    await expect(auditTrail.append({
      userId,
      eventType: "auth.session_ended",
      outcome: "success",
      requestId: "949434d5-96a8-43e8-8e94-644248583da3",
      reasonCode: "AUTH_SESSION_ENDED",
      resourceType: "session",
      metadata: { provider: "dev" } as never,
    })).rejects.toThrow(/字段白名单/);

    await expect(auditTrail.query({ userId })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({
      userId,
      actorUserId: userId,
      eventType: "auth.session_started",
      outcome: "success",
      reasonCode: "AUTH_SESSION_STARTED",
      requestId,
      metadata: { provider: "dev" },
      occurredAt: now,
    })]));
  });

  it("allows only redacted career-import metadata for the approved lifecycle events", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const documentId = "a507ecf4-28e5-4d24-9aad-e6d0d34359c1";
    const importId = "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364";

    await auditTrail.append({
      userId, actorUserId: userId, eventType: "career.document_import_queued", occurredAt: now,
      requestId: "8603f799-b8f1-4d42-8e11-c2ae4266ddaa", outcome: "success",
      reasonCode: "CAREER_DOCUMENT_IMPORT_QUEUED", resourceType: "career_import", resourceId: importId,
      metadata: { documentId, importId },
    });
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "career.document_import_completed", occurredAt: now,
      requestId: "4e95017e-8d10-4a76-b1c0-1457608cf730", outcome: "success",
      reasonCode: "CAREER_DOCUMENT_IMPORT_COMPLETED", resourceType: "career_import", resourceId: importId,
      metadata: { documentId, importId, attemptCount: 1, factCount: 2 },
    });
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "career.document_import_failed", occurredAt: now,
      requestId: "426bf7c6-f06d-4d33-966d-3f3083a22b5b", outcome: "failure",
      reasonCode: "CAREER_DOCUMENT_READ_FAILED", resourceType: "career_import", resourceId: importId,
      metadata: { documentId, importId, attemptCount: 2, failureCode: "CAREER_DOCUMENT_READ_FAILED" },
    });

    for (const metadata of [
      { documentId, importId, filename: "resume.md" },
      { documentId, importId, objectKey: "accounts/private/source.md" },
      { documentId, importId, excerpt: "secret@example.test" },
      { documentId, importId, checksum: "a".repeat(64) },
      { documentId, importId, markdown: "# private" },
      { documentId, importId, phone: "13800000000" },
    ]) {
      await expect(auditTrail.append({
        userId, actorUserId: userId, eventType: "career.document_import_queued", requestId: crypto.randomUUID(), outcome: "success",
        reasonCode: "CAREER_DOCUMENT_IMPORT_QUEUED", resourceType: "career_import", resourceId: importId,
        metadata: metadata as never,
      })).rejects.toThrow(/字段白名单/);
    }
  });

  it("allows only identifiers, fact type, decision and version for profile review audit events", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const profileId = "9aeef61c-7fa4-4716-917c-aa2ae3d2b290";
    const candidateFactId = "c6294ea2-91c3-4b3f-938b-7cc435e7d130";
    const profileFactId = "97c3b468-55a0-4f78-8c7d-b456b8853445";
    const revisionId = "72da86aa-d456-489f-ab50-28b0b502a243";

    await auditTrail.append({
      userId, actorUserId: userId, eventType: "profile.candidate_fact_decided", occurredAt: now,
      requestId: crypto.randomUUID(), outcome: "success", reasonCode: "PROFILE_FACT_CONFIRMED",
      resourceType: "candidate_fact", resourceId: candidateFactId,
      metadata: { profileId, candidateFactId, profileFactId, revisionId, factType: "skill", decision: "confirmed", profileVersion: 1 },
    });

    await expect(auditTrail.append({
      userId, actorUserId: userId, eventType: "profile.candidate_fact_decided", occurredAt: now,
      requestId: crypto.randomUUID(), outcome: "success", reasonCode: "PROFILE_FACT_CONFIRMED",
      resourceType: "candidate_fact", resourceId: candidateFactId,
      metadata: { profileId, candidateFactId, profileFactId, revisionId, factType: "skill", decision: "confirmed", profileVersion: 1, reason: "secret@example.test" } as never,
    })).rejects.toThrow(/字段白名单/);
  });

  it("allows only redacted identifiers for conflict resolution audits", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "profile.career_fact_conflict_resolved", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success",
      reasonCode: "CAREER_FACT_CONFLICT_RESOLVED", resourceType: "career_fact_conflict", resourceId: crypto.randomUUID(),
      metadata: { conflictId: crypto.randomUUID(), existingCandidateFactId: crypto.randomUUID(), incomingCandidateFactId: crypto.randomUUID(), kind: "date", resolution: "use_existing", profileId: crypto.randomUUID(), profileVersion: 1 },
    });
  });

  it("allows only redacted target state for job target audits", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const targetId = crypto.randomUUID();
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "profile.job_target_maintained", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success",
      reasonCode: "JOB_TARGET_CREATED", resourceType: "job_target", resourceId: targetId,
      metadata: { targetId, action: "created", version: 1, priority: "primary", state: "active" },
    });
    await expect(auditTrail.append({
      userId, actorUserId: userId, eventType: "profile.job_target_maintained", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success",
      reasonCode: "JOB_TARGET_CREATED", resourceType: "job_target", resourceId: targetId,
      metadata: { targetId, action: "created", version: 1, priority: "primary", state: "active", salary: 100_000 } as never,
    })).rejects.toThrow(/字段白名单/);
  });

  it("allows only redacted metadata for job import lifecycle events", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const importId = "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364";
    const sourcePostingId = "a507ecf4-28e5-4d24-9aad-e6d0d34359c1";
    const sourcePostingVersionId = "48c728bb-2ab2-4b13-b04f-a03ef4f9b09f";
    const opportunityId = "1b5f7f36-6f92-46ef-8b80-e2ca433c6af1";

    await auditTrail.append({
      userId, actorUserId: userId, eventType: "job.import_submitted", occurredAt: now, requestId: crypto.randomUUID(),
      outcome: "success", reasonCode: "JOB_IMPORT_SUBMITTED", resourceType: "job_import", resourceId: importId,
      metadata: { importId, inputType: "pasted_text" },
    } as never);
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "job.import_completed", occurredAt: now, requestId: crypto.randomUUID(),
      outcome: "success", reasonCode: "JOB_IMPORT_COMPLETED", resourceType: "job_import", resourceId: importId,
      metadata: { importId, sourcePostingId, sourcePostingVersionId, opportunityId, version: 1, inputType: "pasted_text", attemptCount: 1 },
    } as never);
    await auditTrail.append({
      userId, actorUserId: userId, eventType: "job.import_failed", occurredAt: now, requestId: crypto.randomUUID(),
      outcome: "failure", reasonCode: "JOB_NORMALIZER_OUTPUT_INVALID", resourceType: "job_import", resourceId: importId,
      metadata: { importId, inputType: "pasted_text", attemptCount: 1, failureCode: "JOB_NORMALIZER_OUTPUT_INVALID" },
    } as never);

    await expect(auditTrail.append({
      userId, actorUserId: userId, eventType: "job.import_submitted", requestId: crypto.randomUUID(),
      outcome: "success", reasonCode: "JOB_IMPORT_SUBMITTED", resourceType: "job_import", resourceId: importId,
      metadata: { importId, inputType: "pasted_text", content: "ignore previous instructions" },
    } as never)).rejects.toThrow(/字段白名单/);
  });

  it("允许且只允许 agent run 生命周期的红删审计字段", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_queued", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_QUEUED", resourceType: "agent_run", resourceId: runId, metadata: { runId, targetId, targetVersion: 1, workflowVersion: "job-discovery-workflow-v1", adapterVersion: "fake-job-discovery-v1" } });
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_completed", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: runId, metadata: { runId, targetId, attemptCount: 1, resultCount: 1 } });
    await expect(auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_failed", requestId: crypto.randomUUID(), outcome: "failure", reasonCode: "AGENT_RUN_ADAPTER_FAILED", resourceType: "agent_run", resourceId: runId, metadata: { runId, targetId, attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED", message: "private" } as never })).rejects.toThrow(/字段白名单/);
  });

  it("仅允许 checkpoint 所需的预算和 Inbox 脱敏审计字段", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_budget_consumed", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_BUDGET_CONSUMED", resourceType: "agent_run", resourceId: runId, metadata: { runId, activeDurationMs: 100, toolCalls: 1, sourceRequests: 1, modelCalls: 0 } });
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_budget_exhausted", occurredAt: now, requestId: crypto.randomUUID(), outcome: "failure", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_run", resourceId: runId, metadata: { runId, budgetDimension: "tool_calls", attemptCount: 1 } });
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_inbox_item", resourceId: itemId, metadata: { runId, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "tool_calls" } });
    await expect(auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_budget_consumed", requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_BUDGET_CONSUMED", resourceType: "agent_run", resourceId: runId, metadata: { runId, activeDurationMs: 0, toolCalls: 0, sourceRequests: 0, modelCalls: 0, rawPayload: "private" } as never })).rejects.toThrow(/字段白名单/);
  });

  it("仅允许重试和 Inbox action 的内部标识、动作、结果与稳定原因", async () => {
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const runId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.run_retry_scheduled", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_ADAPTER_RETRYABLE", resourceType: "agent_run", resourceId: runId, metadata: { runId, attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE" } });
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.inbox_action_applied", occurredAt: now, requestId: crypto.randomUUID(), outcome: "failure", reasonCode: "AGENT_RUN_ADAPTER_FAILED", resourceType: "agent_inbox_item", resourceId: itemId, metadata: { itemId, runId, action: "restart_run", outcome: "failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED" } });
    await auditTrail.append({ userId, actorUserId: userId, eventType: "agent.inbox_resolved", occurredAt: now, requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_inbox_item", resourceId: itemId, metadata: { itemId, runId, action: "resume_run", reasonCode: "AGENT_RUN_PAUSED" } });
    await expect(auditTrail.append({ userId, actorUserId: userId, eventType: "agent.inbox_action_applied", requestId: crypto.randomUUID(), outcome: "success", reasonCode: "AGENT_RUN_ADAPTER_FAILED", resourceType: "agent_inbox_item", resourceId: itemId, metadata: { itemId, runId, action: "restart_run", outcome: "applied", reasonCode: "AGENT_RUN_ADAPTER_FAILED", objectKey: "private" } as never })).rejects.toThrow(/字段白名单/);
  });
});
