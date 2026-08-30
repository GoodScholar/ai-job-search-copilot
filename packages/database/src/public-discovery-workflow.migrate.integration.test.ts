import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("public discovery workflow migration", () => {
  it("为 v4 冻结快照和独立发现诊断提供 additive 0025 迁移", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0025_layered_public_discovery_workflow.sql", import.meta.url)), "utf8");

    expect(migrationSql).toContain('ADD COLUMN "profile_snapshot"');
    expect(migrationSql).toContain('ADD COLUMN "watchlist_snapshot"');
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_diagnostics"');
    expect(migrationSql).toContain('UNIQUE NULLS NOT DISTINCT("user_id","run_id","scope","provider","query_id","lead_id","code")');
    expect(migrationSql).not.toContain("job_source_health_checks");
  });

  it("以独立 additive 0026 将发现关注项与 Watchlist 来源关注项隔离", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0026_discovery_attention.sql", import.meta.url)), "utf8");

    expect(migrationSql).toContain('discovery_attention');
    expect(migrationSql).toContain('DISCOVERY_ATTENTION');
    expect(migrationSql).toContain("SOURCE_HEALTH_ATTENTION");
  });

  it("以 additive 0027 固化 v4 result/source issue 的 owner 约束和双唯一结果身份", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0027_massive_purple_man.sql", import.meta.url)), "utf8");
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_run_results"');
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_source_issues"');
    expect(migrationSql).toContain('UNIQUE("user_id","run_id","ordinal")');
    expect(migrationSql).toContain('UNIQUE("user_id","run_id","source_posting_version_id")');
    expect(migrationSql).toContain('job_discovery_run_results_owner_run_fk');
    expect(migrationSql).toContain('job_discovery_source_issues_owner_run_fk');
    expect(migrationSql).toContain('ordinal" between 1 and 5');
  });
});
