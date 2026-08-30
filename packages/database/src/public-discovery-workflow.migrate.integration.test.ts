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
});
