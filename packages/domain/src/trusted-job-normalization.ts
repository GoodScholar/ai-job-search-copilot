import type { DiscoveryDetail } from "./job-discovery-persistence";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { jobSourcePostings, jobSourcePostingVersions } from "@job-copilot/database";
import { validateJobNormalizerOutput, validatePersistedJobNormalizerOutput, type JobNormalizerOutput } from "@job-copilot/contracts/job-imports";
import type { JobNormalizerMetadata } from "@job-copilot/contracts/job-normalizer";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Greenhouse 的展示字段不构成模型输入权威性。只把原始响应中的已知字段按固定
 * 顺序交给 normalizer，HTML 与链接始终是普通不可信数据。
 */
export function buildTrustedNormalizationContent(detail: DiscoveryDetail): string {
  const raw = detail.rawPayload;
  const location = raw.location && typeof raw.location === "object" && !Array.isArray(raw.location)
    ? nonEmptyString((raw.location as Record<string, unknown>).name)
    : null;
  const fields: Array<[string, string | null]> = [
    ["公司", nonEmptyString(raw.company_name)],
    ["标题", nonEmptyString(raw.title)],
    ["地点", location],
    ["发布时间", nonEmptyString(raw.first_published)],
    ["截止时间", nonEmptyString(raw.application_deadline)],
    ["描述", nonEmptyString(raw.content)],
  ];
  return fields.flatMap(([label, value]) => value === null ? [] : [`${label}：${value}`]).join("\n");
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}

function rawHash(detail: DiscoveryDetail): string {
  return createHash("sha256").update(JSON.stringify(stableJson(detail.rawPayload))).digest("hex");
}

function sourceIdentifier(detail: DiscoveryDetail): string {
  return createHash("sha256").update(JSON.stringify(stableJson({ sourceId: detail.sourceId, detailId: detail.detailId }))).digest("hex");
}

function sameMetadata(output: JobNormalizerOutput, metadata: JobNormalizerMetadata): boolean {
  return output.adapter === metadata.adapter && output.normalizerVersion === metadata.normalizerVersion && output.model === metadata.model
    && output.promptVersion === metadata.promptVersion && output.outputSchemaVersion === metadata.outputSchemaVersion && output.ruleVersion === metadata.ruleVersion;
}

/** 在模型调用前只读复用完整、已绑定且与原 payload/冻结 metadata 一致的版本。 */
export async function normalizeTrustedDetails(input: {
  db: any; userId: string; metadata: JobNormalizerMetadata; details: DiscoveryDetail[];
  normalizePosting(value: { identity: string; content: string }): Promise<JobNormalizerOutput>;
}): Promise<Array<DiscoveryDetail & { normalization: JobNormalizerOutput }>> {
  const normalized: Array<DiscoveryDetail & { normalization: JobNormalizerOutput }> = [];
  for (const detail of input.details) {
    const identity = sourceIdentifier(detail);
    const content = buildTrustedNormalizationContent(detail);
    const [existing] = await input.db.select({ id: jobSourcePostingVersions.id, rawContentSha256: jobSourcePostingVersions.rawContentSha256, normalizedData: jobSourcePostingVersions.normalizedData })
      .from(jobSourcePostingVersions).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId)))
      .where(and(eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostings.sourceType, detail.sourceType), eq(jobSourcePostings.sourceIdentifier, identity), eq(jobSourcePostingVersions.rawContentSha256, rawHash(detail))))
      .orderBy(desc(jobSourcePostingVersions.version)).limit(1);
    if (existing) {
      try {
        const output = validatePersistedJobNormalizerOutput(existing.normalizedData, { sourcePostingVersionId: existing.id, metadata: input.metadata });
        if (output.usage.status === "known" && validateJobNormalizerOutput(content, output)) { normalized.push({ ...detail, normalization: output }); continue; }
      } catch { /* 旧版本或冻结 metadata 不一致时必须重算。 */ }
    }
    const output = await input.normalizePosting({ identity, content });
    if (output.usage.status !== "known" || !sameMetadata(output, input.metadata) || !validateJobNormalizerOutput(content, output)) throw new Error("TRUSTED_JOB_NORMALIZATION_INVALID");
    normalized.push({ ...detail, normalization: output });
  }
  return normalized;
}
