import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { createDatabase, migrateDatabase, type Database } from "@job-copilot/database";
import type { ModelDiagnosticAdapter, ModelDiagnosticProbeResult } from "@job-copilot/contracts/model-diagnostics";
import { createModelDiagnostics } from "./model-diagnostics";

const available: ModelDiagnosticProbeResult = {
  status: "available", reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s",
  checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" },
};
const unavailable: ModelDiagnosticProbeResult = {
  status: "temporarily_unavailable", reasonCode: "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE", latencyBucket: "under_1s",
  checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
};

function adapter(fingerprint: string, result: ModelDiagnosticProbeResult = available) {
  let calls = 0;
  const value: ModelDiagnosticAdapter = { configurationFingerprint: fingerprint, async diagnose() { calls += 1; return result; } };
  return { value, calls: () => calls };
}

describe("模型连接诊断持久化协调", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  let now: Date;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });
  const service = (model: ModelDiagnosticAdapter, timeoutMs?: number) => createModelDiagnostics({ db: database, adapter: model, clock: () => now, timeoutMs });
  const fresh = () => { now = new Date(`2026-09-05T00:00:${String(Math.floor(Math.random() * 59)).padStart(2, "0")}.000Z`); };

  it("当前指纹从未检查时读取 unverified，运行后只保存安全稳定字段", async () => {
    fresh(); const fake = adapter(`first-${crypto.randomUUID()}`); const diagnostics = service(fake.value);
    await expect(diagnostics.get()).resolves.toMatchObject({ status: "unverified", checkedAt: null, retryAt: null });
    await expect(diagnostics.run()).resolves.toMatchObject({ status: "available", checks: available.checks, checkedAt: now.toISOString() });
    expect(fake.calls()).toBe(1);
    await expect(database.execute(sql`select column_name from information_schema.columns where table_name = 'model_diagnostic_results' order by ordinal_position`)).resolves.toEqual([
      { column_name: "configuration_fingerprint" }, { column_name: "status" }, { column_name: "checks" },
      { column_name: "reason_code" }, { column_name: "checked_at" }, { column_name: "latency_bucket" },
    ]);
  });

  it("成功仅在严格十分钟内复用，到边界和任一新指纹立即重新诊断", async () => {
    now = new Date("2026-09-05T00:10:00.000Z"); const same = adapter(`cache-${crypto.randomUUID()}`); const first = service(same.value);
    await first.run(); now = new Date("2026-09-05T00:19:59.999Z"); await expect(first.run()).resolves.toMatchObject({ status: "available" });
    expect(same.calls()).toBe(1);
    now = new Date("2026-09-05T00:20:00.000Z"); await first.run(); expect(same.calls()).toBe(2);
    const changed = adapter(`changed-${crypto.randomUUID()}`); await service(changed.value).run(); expect(changed.calls()).toBe(1);
  });

  it("GET 在成功复用边界后仍显示最近稳定结果，POST 才重新探针", async () => {
    now = new Date("2026-09-05T03:00:00.000Z"); const fake = adapter(`get-success-${crypto.randomUUID()}`); const diagnostics = service(fake.value);
    await diagnostics.run(); now = new Date("2026-09-05T03:10:00.000Z");
    await expect(diagnostics.get()).resolves.toMatchObject({ status: "available", retryAt: null }); expect(fake.calls()).toBe(1);
    await diagnostics.run(); expect(fake.calls()).toBe(2);
  });

  it("连续稳定失败按上限指数退避，结束后允许新的探针", async () => {
    now = new Date("2026-09-05T01:00:00.000Z"); const fake = adapter(`failure-${crypto.randomUUID()}`, unavailable); const diagnostics = service(fake.value);
    const first = await diagnostics.run(); expect(first.retryAt).toBe("2026-09-05T01:00:30.000Z");
    now = new Date("2026-09-05T01:00:29.999Z"); await expect(diagnostics.run()).resolves.toMatchObject({ status: "temporarily_unavailable", retryAt: "2026-09-05T01:00:30.000Z" }); expect(fake.calls()).toBe(1);
    now = new Date("2026-09-05T01:00:30.000Z"); await diagnostics.run(); expect(fake.calls()).toBe(2);
    now = new Date("2026-09-05T01:01:30.000Z"); await diagnostics.run();
    now = new Date("2026-09-05T01:03:30.000Z"); await diagnostics.run();
    now = new Date("2026-09-05T01:07:30.000Z"); await diagnostics.run();
    now = new Date("2026-09-05T01:15:30.000Z"); const capped = await diagnostics.run();
    expect(capped.retryAt).toBe("2026-09-05T01:25:30.000Z");
  });

  it("GET 在失败退避边界后保留失败结果但允许重试", async () => {
    now = new Date("2026-09-05T04:00:00.000Z"); const fake = adapter(`get-failure-${crypto.randomUUID()}`, unavailable); const diagnostics = service(fake.value);
    await diagnostics.run(); now = new Date("2026-09-05T04:00:30.000Z");
    await expect(diagnostics.get()).resolves.toMatchObject({ status: "temporarily_unavailable", retryAt: null }); expect(fake.calls()).toBe(1);
  });

  it("锁竞争不会等待或外呼：GET 与 POST 都返回 checking", async () => {
    fresh(); const fingerprint = `locked-${crypto.randomUUID()}`; const fake = adapter(fingerprint); const lock = await database.$client.reserve();
    try {
      await lock`begin`; await lock`select pg_advisory_xact_lock(hashtextextended(${fingerprint}, 50))`;
      const other = createDatabase(container.getConnectionUri());
      try {
        await expect(createModelDiagnostics({ db: other, adapter: fake.value, clock: () => now }).get()).resolves.toMatchObject({ status: "checking" });
        await expect(createModelDiagnostics({ db: other, adapter: fake.value, clock: () => now }).run()).resolves.toMatchObject({ status: "checking" });
      } finally { await other.$client.end(); }
      expect(fake.calls()).toBe(0);
    } finally { await lock`rollback`; lock.release(); }
  });

  it("同一指纹二十个并发运行至多执行一轮 Adapter 探针", async () => {
    fresh(); const fake = adapter(`concurrent-${crypto.randomUUID()}`); const clients = Array.from({ length: 20 }, () => createDatabase(container.getConnectionUri()));
    try {
      const outcomes = await Promise.all(clients.map((db) => createModelDiagnostics({ db, adapter: fake.value, clock: () => now }).run()));
      expect(outcomes.filter((value) => value.status === "available" || value.status === "checking")).toHaveLength(20);
      expect(fake.calls()).toBeLessThanOrEqual(1);
    } finally { await Promise.all(clients.map((db) => db.$client.end())); }
  });

  it("同一 service 的进行中探针使重复 GET 和 POST 不进入第二个事务", async () => {
    fresh(); const fingerprint = `in-flight-${crypto.randomUUID()}`; let release: (() => void) | undefined; let entered: (() => void) | undefined;
    const blocked: ModelDiagnosticAdapter = { configurationFingerprint: fingerprint, diagnose: () => new Promise((resolve) => { entered = () => resolve(available); release = entered; }) };
    let transactions = 0; const original = database.transaction.bind(database);
    const tracked = Object.assign(Object.create(database), { transaction: (...args: Parameters<Database["transaction"]>) => { transactions += 1; return original(...args); } }) as Database;
    const diagnostics = createModelDiagnostics({ db: tracked, adapter: blocked, clock: () => now }); const first = diagnostics.run();
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(diagnostics.get()).resolves.toMatchObject({ status: "checking" }); await expect(diagnostics.run()).resolves.toMatchObject({ status: "checking" }); expect(transactions).toBe(1);
    release!(); await first;
  });

  it("意外异常被净化为稳定失败，不把 Error 内容带入响应", async () => {
    fresh(); const secret = "api-key-secret-sentinel";
    const broken: ModelDiagnosticAdapter = { configurationFingerprint: `broken-${crypto.randomUUID()}`, async diagnose() { throw new Error(secret); } };
    const result = await service(broken).run();
    expect(result).toMatchObject({ status: "failed", reasonCode: "MODEL_DIAGNOSTIC_FAILED" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("Adapter 忽略取消并永不结束时仍在总截止后持久化超时并释放锁", async () => {
    fresh(); const fingerprint = `never-settles-${crypto.randomUUID()}`;
    let calls = 0;
    const firstThenAvailable: ModelDiagnosticAdapter = { configurationFingerprint: fingerprint, diagnose: async () => ++calls === 1 ? new Promise<ModelDiagnosticProbeResult>(() => undefined) : available };
    const timedOut = await service(firstThenAvailable, 1).run();
    expect(timedOut).toMatchObject({ status: "temporarily_unavailable", reasonCode: "MODEL_DIAGNOSTIC_TIMEOUT", latencyBucket: "timeout", checks: { timeout: "failed" } });
    now = new Date(timedOut.retryAt!);
    const other = createDatabase(container.getConnectionUri());
    try { await expect(createModelDiagnostics({ db: other, adapter: firstThenAvailable, clock: () => now, timeoutMs: 1 }).run()).resolves.toMatchObject({ status: "available" }); }
    finally { await other.$client.end(); }
    expect(calls).toBe(2);
  });

  it("成功会重置连续失败退避，全部稳定原因码都有受限中文投影", async () => {
    now = new Date("2026-09-05T02:00:00.000Z"); const fingerprint = `reset-${crypto.randomUUID()}`;
    const failing = adapter(fingerprint, unavailable); await service(failing.value).run();
    now = new Date("2026-09-05T02:00:30.000Z"); const succeeding = adapter(fingerprint); await service(succeeding.value).run();
    now = new Date("2026-09-05T02:10:30.000Z"); const failingAgain = adapter(fingerprint, unavailable); const reset = await service(failingAgain.value).run();
    expect(reset.retryAt).toBe("2026-09-05T02:11:00.000Z");
    const reasons: Array<[ModelDiagnosticProbeResult["reasonCode"], string, string, string[]]> = [
      ["MODEL_DIAGNOSTIC_AVAILABLE", "模型连接正常", "两档业务模型可以执行受限诊断。", []], ["MODEL_DIAGNOSTIC_CONFIGURATION_MISSING", "模型服务尚未配置", "当前部署无法发起模型请求。", ["请联系部署管理员配置模型服务。"]], ["MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", "模型服务认证失败", "模型功能暂不可用。", ["请联系部署管理员检查服务凭据。"]], ["MODEL_DIAGNOSTIC_ACCESS_RESTRICTED", "模型服务访问受限", "当前部署无法使用所需模型能力。", ["请联系部署管理员检查访问权限。"]], ["MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE", "基础模型不可用", "部分模型功能暂不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]], ["MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE", "高质量模型不可用", "需要高质量模型的功能暂不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]], ["MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED", "模型返回格式异常", "模型结果暂不能安全用于求职流程。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]], ["MODEL_DIAGNOSTIC_TIMEOUT", "模型服务响应超时", "模型功能暂时不可用。", ["请稍后重试。"]], ["MODEL_DIAGNOSTIC_RATE_LIMITED", "模型服务暂时繁忙", "模型功能暂时不可用。", ["请稍后重试。"]], ["MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE", "模型服务暂不可用", "模型功能暂时不可用。", ["请稍后重试。"]], ["MODEL_DIAGNOSTIC_FAILED", "模型连接检查失败", "模型功能暂时不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]],
    ];
    for (const [reasonCode, reasonSummary, impact, suggestedActions] of reasons) {
      const projected = await service(adapter(`reason-${reasonCode}-${crypto.randomUUID()}`, { ...unavailable, reasonCode }).value).run();
      expect(projected).toMatchObject({ reasonSummary, impact, suggestedActions });
    }
  });
});
