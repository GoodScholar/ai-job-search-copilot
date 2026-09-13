import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";

const recommendationContext = {
  version: "recommendation-context-v1",
  profile: { profileId: "11111111-1111-4111-8111-111111111111", profileVersion: 1 },
  budgets: { discovery: {}, deepMatch: {} },
  preflight: {},
  accountPolicyRevisionNumber: 0,
};

const safeEvidence = {
  discovery: {}, sourceCoverage: {}, coverageLosses: [], qualification: {}, coarseRanking: {}, deepMatching: {}, suggestedActions: [],
};

async function insertRun(database: Database, input: {
  id?: string; userId: string; targetId: string; purpose: "job_discovery" | "opportunity_reevaluation" | "recommendation";
  workflow?: "job-discovery-workflow-v1" | "job-discovery-workflow-v3" | "layered-public-job-discovery-v1" | "deep-match-v1" | "workflow-v2" | "workflow-v4"; parentRunId?: string | null; trigger?: "manual" | "automatic" | null; context?: unknown;
}) {
  const id = input.id ?? crypto.randomUUID();
  const workflow = input.workflow ?? "layered-public-job-discovery-v1";
  await database.execute(sql`
    insert into agent_runs (
      id, user_id, target_id, idempotency_key, target_version, target_snapshot, profile_snapshot, watchlist_snapshot,
      source_scope, budget_snapshot, workflow_version, rule_version, adapter, adapter_version, output_schema_version,
      tool_allowlist, model_snapshot, status, current_step, run_purpose, parent_run_id, recommendation_context
    ) values (
      ${id}, ${input.userId}, ${input.targetId}, ${crypto.randomUUID()}, 1,
      ${JSON.stringify({ targetId: input.targetId })}::jsonb,
      ${workflow === "layered-public-job-discovery-v1" ? JSON.stringify({ targetId: input.targetId }) : null}::jsonb,
      ${workflow === "layered-public-job-discovery-v1" ? JSON.stringify({ targetId: input.targetId }) : null}::jsonb,
      ${JSON.stringify(input.trigger === null ? {} : { trigger: input.trigger ?? "manual" })}::jsonb, '{}'::jsonb, ${workflow}, 'rules-v1', 'adapter', 'v1', 'result-v1', '[]'::jsonb,
      ${workflow === "deep-match-v1" ? "{}" : null}::jsonb, 'queued', 'queued', ${input.purpose}, ${input.parentRunId ?? null}, ${input.context === undefined ? null : JSON.stringify(input.context)}::jsonb
    )
  `);
  return id;
}

async function migrateAt0051(database: Database) {
  const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0051-recommendation-topology-"));
  const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
  await cp(migrationSource, migrationsFolder, { recursive: true });
  await unlink(join(migrationsFolder, "0052_recommendation_root_discovery_workflows.sql"));
  await unlink(join(migrationsFolder, "meta", "0052_snapshot.json"));
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter(({ tag }) => tag !== "0052_recommendation_root_discovery_workflows");
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await migrate(database, { migrationsFolder });
  return migrationsFolder;
}

async function insertListItem(database: Database, userId: string, targetId: string, listId: string, existingMatchId?: string, existingProfileId?: string, ordinal = 1) {
  if (existingMatchId) {
    const itemId = crypto.randomUUID();
    await database.execute(sql`insert into recommendation_list_items (id, user_id, recommendation_list_id, match_version_id, ordinal) values (${itemId}, ${userId}, ${listId}, ${existingMatchId}, ${ordinal})`);
    return { itemId, matchId: existingMatchId };
  }
  const [postingId, postingVersionId, opportunityId, triageId, matchId, itemId] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const profileId = existingProfileId ?? crypto.randomUUID();
  const dedupKey = crypto.randomUUID().replaceAll("-", "").repeat(2);
  if (!existingProfileId) await database.execute(sql`insert into job_profiles (id, user_id, version) values (${profileId}, ${userId}, 1)`);
  await database.execute(sql`insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity) values (${postingId}, ${userId}, 'fake', ${postingId}, '{}'::jsonb)`);
  await database.execute(sql`insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at) values (${postingVersionId}, ${userId}, ${postingId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, now())`);
  await database.execute(sql`insert into job_opportunities (id, user_id, source_posting_version_id, dedup_key, normalized_data) values (${opportunityId}, ${userId}, ${postingVersionId}, ${dedupKey}, '{}'::jsonb)`);
  await database.execute(sql`insert into job_triage_versions (id, user_id, opportunity_id, source_posting_version_id, profile_id, profile_version, target_id, target_version, qualification_rule_version, coarse_rule_version, overall_verdict, gate_results, pending_items, deadline_status, confidence_basis_points, dimension_scores, overall_score, threshold, sequence) values (${triageId}, ${userId}, ${opportunityId}, ${postingVersionId}, ${profileId}, 1, ${targetId}, 1, 'qualification-v1', 'coarse-v1', 'pass', '{}'::jsonb, '[]'::jsonb, 'valid', 10000, '{}'::jsonb, 90, 70, 1)`);
  await database.execute(sql`insert into job_match_versions (id, user_id, opportunity_id, source_posting_version_id, triage_version_id, profile_id, profile_version, target_id, target_version, rule_version, prompt_version, adapter, adapter_version, model, output_schema_version, overall_score, display_band, assessment, sequence) values (${matchId}, ${userId}, ${opportunityId}, ${postingVersionId}, ${triageId}, ${profileId}, 1, ${targetId}, 1, 'rules-v1', 'prompt-v1', 'fake', 'fake-v1', 'fake-model', 'result-v1', 90, 'highly_matched', '{}'::jsonb, 1)`);
  await database.execute(sql`insert into recommendation_list_items (id, user_id, recommendation_list_id, match_version_id, ordinal) values (${itemId}, ${userId}, ${listId}, ${matchId}, ${ordinal})`);
  return { itemId, matchId, profileId };
}

describe("recommendation run persistence migration", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  let databaseUrl: string;
  const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherOwnerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const otherTargetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ownerOtherTargetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = container.getConnectionUri();
    database = createDatabase(databaseUrl);
    await migrateDatabase(database);
    await database.execute(sql`insert into job_accounts (id) values (${ownerId}), (${otherOwnerId})`);
    await database.execute(sql`
      insert into job_targets (id, user_id, version, priority, state) values
      (${targetId}, ${ownerId}, 1, 'primary', 'active'), (${ownerOtherTargetId}, ${ownerId}, 1, 'secondary', 'inactive'),
      (${otherTargetId}, ${otherOwnerId}, 1, 'primary', 'active')
    `);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("enforces recommendation root and child topology without changing legacy automatic runs", async () => {
    const legacyAutomatic = await insertRun(database, { userId: ownerId, targetId, purpose: "job_discovery", workflow: "deep-match-v1", trigger: "automatic" });
    const legacy = await database.execute(sql`select run_purpose, parent_run_id from agent_runs where id = ${legacyAutomatic}`) as unknown as Array<{ run_purpose: string; parent_run_id: string | null }>;
    expect(legacy).toEqual([{ run_purpose: "job_discovery", parent_run_id: null }]);

    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId })).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "manual", parentRunId: rootId })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "workflow-v4", parentRunId: rootId })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: null })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId, context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: otherOwnerId, targetId: otherTargetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(database.execute(sql`update agent_runs set parent_run_id = ${childId} where id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects SQL NULL context, missing automatic trigger, and an invalid recommendation root workflow", async () => {
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation" })).rejects.toMatchObject({ cause: { code: "23514" } });
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", parentRunId: rootId, trigger: null })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "workflow-v4", context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("允许三种当前发现根并保留 automatic child 与非法拓扑拒绝", async () => {
    const roots = await Promise.all([
      "job-discovery-workflow-v1",
      "job-discovery-workflow-v3",
      "layered-public-job-discovery-v1",
    ].map((workflow) => insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: workflow as "job-discovery-workflow-v1" | "job-discovery-workflow-v3" | "layered-public-job-discovery-v1", context: recommendationContext })));

    for (const rootId of roots) {
      await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId })).resolves.toBeDefined();
    }
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "workflow-v2", context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "manual", parentRunId: roots[0] })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: otherOwnerId, targetId: otherTargetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: roots[0] })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: roots[0] })).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(database.execute(sql`update agent_runs set workflow_version = 'job-discovery-workflow-v3' where id = ${roots[0]}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("从真实 0051 升级后放宽当前发现根，且不接受未知根", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const legacyDatabase = createDatabase(legacyContainer.getConnectionUri());
    let migrationsFolder: string | undefined;
    const legacyOwnerId = crypto.randomUUID(); const legacyTargetId = crypto.randomUUID();
    try {
      migrationsFolder = await migrateAt0051(legacyDatabase);
      await legacyDatabase.execute(sql`insert into job_accounts (id) values (${legacyOwnerId})`);
      await legacyDatabase.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${legacyTargetId}, ${legacyOwnerId}, 1, 'primary', 'active')`);
      await expect(insertRun(legacyDatabase, { userId: legacyOwnerId, targetId: legacyTargetId, purpose: "recommendation", workflow: "job-discovery-workflow-v1", context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });

      await migrateDatabase(legacyDatabase);

      await expect(insertRun(legacyDatabase, { userId: legacyOwnerId, targetId: legacyTargetId, purpose: "recommendation", workflow: "job-discovery-workflow-v1", context: recommendationContext })).resolves.toBeDefined();
      await expect(insertRun(legacyDatabase, { userId: legacyOwnerId, targetId: legacyTargetId, purpose: "recommendation", workflow: "workflow-v2", context: recommendationContext })).rejects.toMatchObject({ cause: { code: "23514" } });
    } finally {
      await legacyDatabase.$client.end();
      await legacyContainer.stop();
      if (migrationsFolder) await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);

  it("freezes recommendation association identity after a child is created", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    await expect(database.execute(sql`update agent_runs set run_purpose = 'job_discovery' where id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`update agent_runs set run_purpose = 'job_discovery' where id = ${childId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("freezes a recommendation root's owner and target even without children or results", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    await expect(database.execute(sql`update agent_runs set target_id = ${ownerOtherTargetId} where id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`update agent_runs set user_id = ${otherOwnerId}, target_id = ${otherTargetId} where id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("requires a bounded recommendation context and preserves immutable command facts", async () => {
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: [] })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: { ...recommendationContext, version: "wrong" } })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: { ...recommendationContext, preflight: "x".repeat(32_768) } })).rejects.toMatchObject({ cause: { code: "23514" } });
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const commandId = crypto.randomUUID();
    await database.execute(sql`
      insert into recommendation_run_start_commands (user_id, idempotency_key, root_run_id, command_fingerprint)
      values (${ownerId}, ${commandId}, ${rootId}, ${"a".repeat(64)})
    `);
    await expect(database.execute(sql`
      insert into recommendation_run_start_commands (user_id, idempotency_key, root_run_id, command_fingerprint)
      values (${ownerId}, ${commandId}, ${rootId}, ${"a".repeat(64)})
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(database.execute(sql`update recommendation_run_start_commands set command_fingerprint = ${"b".repeat(64)} where user_id = ${ownerId} and idempotency_key = ${commandId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
    await expect(database.execute(sql`delete from recommendation_run_start_commands where user_id = ${ownerId} and idempotency_key = ${commandId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
    const controlCommandId = crypto.randomUUID();
    await database.execute(sql`
      insert into recommendation_run_control_commands (user_id, root_run_id, command_id, physical_run_id, action, command_fingerprint, result_snapshot)
      values (${ownerId}, ${rootId}, ${controlCommandId}, ${rootId}, 'pause', ${"c".repeat(64)}, ${JSON.stringify({ runId: rootId, status: "queued", currentStep: "queued", controlState: "none", version: 1 })}::jsonb)
    `);
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    await expect(database.execute(sql`
      insert into recommendation_run_control_commands (user_id, root_run_id, command_id, physical_run_id, action, command_fingerprint, result_snapshot)
      values (${ownerId}, ${rootId}, ${controlCommandId}, ${childId}, 'pause', ${"c".repeat(64)}, ${JSON.stringify({ runId: childId, status: "queued", currentStep: "queued", controlState: "none", version: 1 })}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(database.execute(sql`update recommendation_run_control_commands set action = 'cancel' where user_id = ${ownerId} and root_run_id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
    await expect(database.execute(sql`delete from recommendation_run_control_commands where user_id = ${ownerId} and root_run_id = ${rootId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
  });

  it("stores deep-match current steps in existing physical control snapshots", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    await database.execute(sql`update agent_runs set status = 'running', current_step = 'select_candidates', started_at = now() where id = ${childId}`);
    await database.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${ownerId}, ${childId}, ${crypto.randomUUID()}, 'pause', true, 1, ${JSON.stringify({ runId: childId, status: "running", currentStep: "select_candidates", controlState: "none", version: 1 })}::jsonb)
    `);
  });

  it("accepts only owner-bound published results and safe no-recommendations inbox references", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    const listId = crypto.randomUUID();
    await database.execute(sql`insert into recommendation_lists (id, user_id, target_id, local_date, sequence) values (${listId}, ${ownerId}, ${targetId}, '2026-09-12', 1)`);
    await expect(database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, recommendation_list_id, item_count, evidence)
      values (${listId}, ${ownerId}, ${targetId}, ${rootId}, ${childId}, 'recommendation_list', ${listId}, 1, ${JSON.stringify(safeEvidence)}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    const noResultRoot = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const noResultChild = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: noResultRoot });
    const noResultId = crypto.randomUUID();
    await database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, recommendation_list_id, item_count, evidence)
      values (${noResultId}, ${ownerId}, ${targetId}, ${noResultRoot}, ${noResultChild}, 'no_recommendations', null, 0, ${JSON.stringify(safeEvidence)}::jsonb)
    `);
    await database.execute(sql`
      insert into agent_inbox_items (id, user_id, recommendation_result_id, kind, status, reason_code)
      values (${crypto.randomUUID()}, ${ownerId}, ${noResultId}, 'recommendation_result', 'unread', 'NO_RECOMMENDATIONS_PUBLISHED')
    `);
    await expect(database.execute(sql`update recommendation_results set evidence = '{"changed":true}'::jsonb where id = ${noResultId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
    await expect(database.execute(sql`delete from recommendation_results where id = ${noResultId}`)).rejects.toMatchObject({ cause: { code: "P0001" } });
  });

  it("rejects non-child producers, mismatched parent targets, duplicate results, and oversized evidence", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    await expect(insertRun(database, { userId: ownerId, targetId: ownerOtherTargetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, item_count, evidence)
      values (${crypto.randomUUID()}, ${ownerId}, ${targetId}, ${rootId}, ${rootId}, 'no_recommendations', 0, ${JSON.stringify(safeEvidence)}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    const resultId = crypto.randomUUID();
    await database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, item_count, evidence)
      values (${resultId}, ${ownerId}, ${targetId}, ${rootId}, ${childId}, 'no_recommendations', 0, ${JSON.stringify(safeEvidence)}::jsonb)
    `);
    await expect(database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, item_count, evidence)
      values (${crypto.randomUUID()}, ${ownerId}, ${targetId}, ${rootId}, ${childId}, 'no_recommendations', 0, ${JSON.stringify(safeEvidence)}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    const oversizedRootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const oversizedChildId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: oversizedRootId });
    await expect(database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, item_count, evidence)
      values (${crypto.randomUUID()}, ${ownerId}, ${targetId}, ${oversizedRootId}, ${oversizedChildId}, 'no_recommendations', 0, ${JSON.stringify({ ...safeEvidence, discovery: { padding: "x".repeat(32_768) } })}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("keeps a published recommendation list nonempty while leaving unpublished lists mutable", async () => {
    const rootId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: ownerId, targetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    const publishedListId = crypto.randomUUID();
    await database.execute(sql`insert into recommendation_lists (id, user_id, target_id, local_date, sequence) values (${publishedListId}, ${ownerId}, ${targetId}, '2026-09-12', 100)`);
    const { itemId, matchId } = await insertListItem(database, ownerId, targetId, publishedListId);
    await database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, recommendation_list_id, item_count, evidence)
      values (${publishedListId}, ${ownerId}, ${targetId}, ${rootId}, ${childId}, 'recommendation_list', ${publishedListId}, 1, ${JSON.stringify(safeEvidence)}::jsonb)
    `);
    await expect(database.execute(sql`delete from recommendation_list_items where id = ${itemId}`)).rejects.toMatchObject({ cause: { code: "23514" } });
    const unpublishedListId = crypto.randomUUID();
    await database.execute(sql`insert into recommendation_lists (id, user_id, target_id, local_date, sequence) values (${unpublishedListId}, ${ownerId}, ${targetId}, '2026-09-12', 101)`);
    const { itemId: unpublishedItemId } = await insertListItem(database, ownerId, targetId, unpublishedListId, matchId);
    await expect(database.execute(sql`delete from recommendation_list_items where id = ${unpublishedItemId}`)).resolves.toBeDefined();
  });

  it("serializes concurrent last-item deletes for a published recommendation list", async () => {
    const rootId = await insertRun(database, { userId: otherOwnerId, targetId: otherTargetId, purpose: "recommendation", context: recommendationContext });
    const childId = await insertRun(database, { userId: otherOwnerId, targetId: otherTargetId, purpose: "recommendation", workflow: "deep-match-v1", trigger: "automatic", parentRunId: rootId });
    const listId = crypto.randomUUID();
    await database.execute(sql`insert into recommendation_lists (id, user_id, target_id, local_date, sequence) values (${listId}, ${otherOwnerId}, ${otherTargetId}, '2026-09-12', 102)`);
    const first = await insertListItem(database, otherOwnerId, otherTargetId, listId);
    const second = await insertListItem(database, otherOwnerId, otherTargetId, listId, undefined, first.profileId, 2);
    await database.execute(sql`
      insert into recommendation_results (id, user_id, target_id, root_run_id, producer_run_id, kind, recommendation_list_id, item_count, evidence)
      values (${listId}, ${otherOwnerId}, ${otherTargetId}, ${rootId}, ${childId}, 'recommendation_list', ${listId}, 2, ${JSON.stringify(safeEvidence)}::jsonb)
    `);
    await database.execute(sql.raw(`
      create sequence recommendation_list_delete_barrier_arrival;
      create sequence recommendation_list_delete_barrier_release minvalue 0 start 0;
      create function recommendation_list_delete_test_barrier() returns trigger language plpgsql as $$
      begin
        perform nextval('recommendation_list_delete_barrier_arrival');
        while not (select is_called from recommendation_list_delete_barrier_release) loop perform pg_sleep(0.01); end loop;
        return old;
      end; $$;
      create trigger zzz_recommendation_list_delete_test_barrier before delete on recommendation_list_items
      for each row execute function recommendation_list_delete_test_barrier();
    `));
    const firstUrl = new URL(databaseUrl); firstUrl.searchParams.set("application_name", "recommendation-list-delete-first");
    const secondUrl = new URL(databaseUrl); secondUrl.searchParams.set("application_name", "recommendation-list-delete-second");
    const firstConnection = createDatabase(firstUrl.toString());
    const secondConnection = createDatabase(secondUrl.toString());
    const firstClient = await firstConnection.$client.reserve();
    const secondClient = await secondConnection.$client.reserve();
    try {
      await firstClient`select set_config('application_name', 'recommendation-list-delete-first', false)`;
      await secondClient`select set_config('application_name', 'recommendation-list-delete-second', false)`;
      const [{ first_pid: firstPid }] = await firstClient`select pg_backend_pid() as first_pid` as unknown as Array<{ first_pid: number }>;
      const [{ second_pid: secondPid }] = await secondClient`select pg_backend_pid() as second_pid` as unknown as Array<{ second_pid: number }>;
      expect(firstPid).not.toBe(secondPid);
      const outcomes = Promise.allSettled([
        (async () => await firstClient`delete from recommendation_list_items where id = ${first.itemId}`)(),
        (async () => await secondClient`delete from recommendation_list_items where id = ${second.itemId}`)(),
      ]);
      let released = false;
      try {
        let arrivals = 0; let waitingPids: number[] = []; let barrierPids: number[] = [];
        for (let attempts = 0; attempts < 200 && (arrivals < 1 || waitingPids.length !== 1 || barrierPids.length !== 1); attempts += 1) {
          const [{ arrivals: currentArrivals }] = await database.execute(sql`select last_value::integer as arrivals from recommendation_list_delete_barrier_arrival`) as unknown as Array<{ arrivals: number }>;
          arrivals = Number(currentArrivals);
          const locks = await database.execute(sql`select pid from pg_stat_activity where pid in (${firstPid}, ${secondPid}) and wait_event_type = 'Lock'`) as unknown as Array<{ pid: number }>;
          waitingPids = locks.map(({ pid }) => pid);
          const barriers = await database.execute(sql`select pid from pg_stat_activity where pid in (${firstPid}, ${secondPid}) and wait_event_type = 'Timeout'`) as unknown as Array<{ pid: number }>;
          barrierPids = barriers.map(({ pid }) => pid);
          if (arrivals < 1 || waitingPids.length !== 1 || barrierPids.length !== 1) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(arrivals).toBe(1);
        expect(waitingPids).toHaveLength(1);
        expect(barrierPids).toHaveLength(1);
        expect(waitingPids[0]).not.toBe(barrierPids[0]);
        await database.execute(sql`select nextval('recommendation_list_delete_barrier_release')`);
        released = true;
        const settled = await outcomes;
        expect(settled.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        const remaining = await database.execute(sql`select id from recommendation_list_items where recommendation_list_id = ${listId}`) as unknown as Array<{ id: string }>;
        expect(remaining).toHaveLength(1);
      } finally {
        if (!released) await database.execute(sql`select nextval('recommendation_list_delete_barrier_release')`).catch(() => undefined);
        await outcomes;
      }
    } finally {
      firstClient.release();
      secondClient.release();
      await firstConnection.$client.end();
      await secondConnection.$client.end();
    }
  });

  it("maps only historical manual deep-match runs to opportunity reevaluation", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const legacyDatabase = createDatabase(legacyContainer.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0048-"));
    try {
      const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await unlink(join(migrationsFolder, "0049_recommendation_runs.sql"));
      await unlink(join(migrationsFolder, "0050_account_run_control.sql"));
      await unlink(join(migrationsFolder, "0051_recommendation_rule_exclusions.sql"));
      await unlink(join(migrationsFolder, "0052_recommendation_root_discovery_workflows.sql"));
      await unlink(join(migrationsFolder, "meta", "0049_snapshot.json"));
      await unlink(join(migrationsFolder, "meta", "0051_snapshot.json"));
      await unlink(join(migrationsFolder, "meta", "0052_snapshot.json"));
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter(({ tag }) => tag !== "0049_recommendation_runs" && tag !== "0050_account_run_control" && tag !== "0051_recommendation_rule_exclusions" && tag !== "0052_recommendation_root_discovery_workflows");
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(legacyDatabase, { migrationsFolder });
      const legacyOwnerId = crypto.randomUUID(); const legacyTargetId = crypto.randomUUID();
      await legacyDatabase.execute(sql`insert into job_accounts (id) values (${legacyOwnerId})`);
      await legacyDatabase.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${legacyTargetId}, ${legacyOwnerId}, 1, 'primary', 'active')`);
      for (const trigger of ["manual", "automatic"] as const) {
        await legacyDatabase.execute(sql`
          insert into agent_runs (id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot, workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, model_snapshot, status, current_step)
          values (${crypto.randomUUID()}, ${legacyOwnerId}, ${legacyTargetId}, ${crypto.randomUUID()}, 1, ${JSON.stringify({ targetId: legacyTargetId })}::jsonb, ${JSON.stringify({ trigger })}::jsonb, '{}'::jsonb, 'deep-match-v1', 'rules-v1', 'adapter', 'v1', 'result-v1', '[]'::jsonb, '{}'::jsonb, 'queued', 'queued')
        `);
      }
      await migrate(legacyDatabase, { migrationsFolder: migrationSource });
      const purposes = await legacyDatabase.execute(sql`select run_purpose, parent_run_id from agent_runs order by source_scope ->> 'trigger'`) as unknown as Array<{ run_purpose: string; parent_run_id: string | null }>;
      expect(purposes).toEqual([{ run_purpose: "job_discovery", parent_run_id: null }, { run_purpose: "opportunity_reevaluation", parent_run_id: null }]);
    } finally {
      await legacyDatabase.$client.end();
      await legacyContainer.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);
});
