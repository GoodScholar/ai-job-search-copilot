import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { modelDiagnosticResults, type Database } from "@job-copilot/database";
import { ModelDiagnosticChecksSchema, ModelDiagnosticPublicResponseSchema, type ModelDiagnosticAdapter, type ModelDiagnosticChecks, type ModelDiagnosticLatencyBucket, type ModelDiagnosticProbeResult, type ModelDiagnosticPublicResponse, type ModelDiagnosticReasonCode } from "@job-copilot/contracts/model-diagnostics";

type Stored = { status: "available" | "failed" | "temporarily_unavailable"; checks: ModelDiagnosticChecks; reasonCode: ModelDiagnosticReasonCode; checkedAt: Date; latencyBucket: ModelDiagnosticLatencyBucket };
type DatabaseLike = Pick<Database, "select" | "insert" | "transaction">;
type Dependencies = { db: DatabaseLike; adapter: ModelDiagnosticAdapter; clock: () => Date };
const tenMinutes = 10 * 60_000;
const backoff = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000];
const unknownChecks: ModelDiagnosticChecks = { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" };

const copy = (checks: ModelDiagnosticChecks): ModelDiagnosticChecks => ({ ...checks });
function words(code: ModelDiagnosticReasonCode) {
  switch (code) {
    case "MODEL_DIAGNOSTIC_AVAILABLE": return ["模型连接正常", "两档业务模型可以执行受限诊断。", []];
    case "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING": return ["模型服务尚未配置", "当前部署无法发起模型请求。", ["请联系部署管理员配置模型服务。"]];
    case "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED": return ["模型服务认证失败", "模型功能暂不可用。", ["请联系部署管理员检查服务凭据。"]];
    case "MODEL_DIAGNOSTIC_ACCESS_RESTRICTED": return ["模型服务访问受限", "当前部署无法使用所需模型能力。", ["请联系部署管理员检查访问权限。"]];
    case "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE": return ["基础模型不可用", "部分模型功能暂不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]];
    case "MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE": return ["高质量模型不可用", "需要高质量模型的功能暂不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]];
    case "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED": return ["模型返回格式异常", "模型结果暂不能安全用于求职流程。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]];
    case "MODEL_DIAGNOSTIC_TIMEOUT": return ["模型服务响应超时", "模型功能暂时不可用。", ["请稍后重试。"]];
    case "MODEL_DIAGNOSTIC_RATE_LIMITED": return ["模型服务暂时繁忙", "模型功能暂时不可用。", ["请稍后重试。"]];
    case "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE": return ["模型服务暂不可用", "模型功能暂时不可用。", ["请稍后重试。"]];
    default: return ["模型连接检查失败", "模型功能暂时不可用。", ["请稍后重试。", "如持续出现，请联系部署管理员。"]];
  }
}
function response(status: "unverified" | "checking" | Stored["status"], row?: Stored, retryAt: Date | null = null): ModelDiagnosticPublicResponse {
  const code = row?.reasonCode ?? "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING";
  const [reasonSummary, impact, suggestedActions] = status === "unverified" ? ["尚未完成模型连接检查", "当前无法确认模型功能是否可用。", ["请运行模型连接检查。"]] : status === "checking" ? ["模型连接正在检查", "检查完成前无法确认模型功能是否可用。", ["请稍后刷新。"]] : words(code);
  return ModelDiagnosticPublicResponseSchema.parse({ status, checks: copy(row?.checks ?? unknownChecks), reasonCode: code, reasonSummary, impact, suggestedActions, checkedAt: row?.checkedAt.toISOString() ?? null, latencyBucket: row?.latencyBucket ?? null, retryAt: retryAt?.toISOString() ?? null });
}
async function latest(db: Pick<Database, "select">, fingerprint: string): Promise<Stored | undefined> {
  const [row] = await db.select({ status: modelDiagnosticResults.status, checks: modelDiagnosticResults.checks, reasonCode: modelDiagnosticResults.reasonCode, checkedAt: modelDiagnosticResults.checkedAt, latencyBucket: modelDiagnosticResults.latencyBucket }).from(modelDiagnosticResults).where(eq(modelDiagnosticResults.configurationFingerprint, fingerprint)).orderBy(desc(modelDiagnosticResults.checkedAt)).limit(1);
  if (!row) return undefined;
  return { status: row.status as Stored["status"], checks: ModelDiagnosticChecksSchema.parse(row.checks), reasonCode: row.reasonCode as ModelDiagnosticReasonCode, checkedAt: row.checkedAt, latencyBucket: row.latencyBucket as ModelDiagnosticLatencyBucket };
}
async function failureCount(db: Pick<Database, "select">, fingerprint: string): Promise<number> {
  const rows = await db.select({ status: modelDiagnosticResults.status }).from(modelDiagnosticResults).where(eq(modelDiagnosticResults.configurationFingerprint, fingerprint)).orderBy(desc(modelDiagnosticResults.checkedAt));
  let count = 0; for (const row of rows) { if (row.status === "available") break; count += 1; } return count;
}
function current(row: Stored | undefined, now: Date, failures: number) {
  if (!row) return undefined;
  if (row.status === "available" && row.checkedAt.getTime() + tenMinutes > now.getTime()) return response(row.status, row);
  if (row.status !== "available") { const retryAt = new Date(row.checkedAt.getTime() + backoff[Math.min(Math.max(failures, 1) - 1, backoff.length - 1)]!); if (retryAt.getTime() > now.getTime()) return response(row.status, row, retryAt); }
  return undefined;
}
function sanitizedFailure(): ModelDiagnosticProbeResult { return { status: "failed", checks: unknownChecks, reasonCode: "MODEL_DIAGNOSTIC_FAILED", latencyBucket: "under_1s" }; }

export function createModelDiagnostics(deps: Dependencies): { get(): Promise<ModelDiagnosticPublicResponse>; run(): Promise<ModelDiagnosticPublicResponse> } {
  const fingerprint = deps.adapter.configurationFingerprint;
  const cached = async (db: Pick<Database, "select">, now: Date) => { const row = await latest(db, fingerprint); return current(row, now, row?.status === "available" ? 0 : await failureCount(db, fingerprint)); };
  return {
    async get() {
      const now = deps.clock(); const existing = await cached(deps.db, now); if (existing) return existing;
      const active = await deps.db.transaction(async (tx) => {
        const [row] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${fingerprint}, 50)) as locked`) as unknown as Array<{ locked: boolean }>;
        if (!row?.locked) return true;
        return false;
      });
      return active ? response("checking") : response("unverified");
    },
    async run() {
      const now = deps.clock(); const existing = await cached(deps.db, now); if (existing) return existing;
      return deps.db.transaction(async (tx) => {
        const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${fingerprint}, 50)) as locked`) as unknown as Array<{ locked: boolean }>;
        if (!lock?.locked) return response("checking");
        const doubleCheck = await cached(tx, now); if (doubleCheck) return doubleCheck;
        let result: ModelDiagnosticProbeResult;
        try { result = await deps.adapter.diagnose({ signal: AbortSignal.timeout(20_000) }); } catch { result = sanitizedFailure(); }
        const checkedAt = deps.clock();
        await tx.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: result.status, checks: result.checks, reasonCode: result.reasonCode, checkedAt, latencyBucket: result.latencyBucket });
        const row: Stored = { ...result, checkedAt };
        const retryAt = result.status === "available" ? null : new Date(checkedAt.getTime() + backoff[Math.min((await failureCount(tx, fingerprint)) - 1, backoff.length - 1)]!);
        return response(result.status, row, retryAt);
      });
    },
  };
}
