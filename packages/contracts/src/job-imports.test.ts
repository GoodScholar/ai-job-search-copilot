import { describe, expect, it } from "vitest";
import {
  CreateJobImportCommandSchema,
  JobImportDetailSchema,
  JobNormalizerModelOutputSchema,
  JobNormalizerOutputSchema,
  validateJobNormalizerOutput,
} from "./job-imports";

describe("job import contracts", () => {
  const importId = "20f47b34-2ec9-4429-9b22-ff60244eb60a";
  const opportunityId = "9e7da78b-9405-49c9-8ca8-45e92bb18487";
  const sourcePostingId = "138cb799-6e0d-43ac-9285-8119dca89ce1";
  const sourcePostingVersionId = "c855fb30-1a1b-490c-9e2e-4e454ea801f2";
  const now = "2026-08-28T00:00:00.000Z";

  it("accepts a pasted job description", () => {
    expect(CreateJobImportCommandSchema.parse({
      inputType: "pasted_text",
      content: "# 高级前端工程师\n公司：示例科技",
    })).toEqual({ inputType: "pasted_text", content: "# 高级前端工程师\n公司：示例科技" });
  });

  it("accepts a public job page URL without accepting a credential-bearing URL", () => {
    expect(CreateJobImportCommandSchema.parse({ inputType: "url", url: "https://jobs.example.com/roles/123" }))
      .toEqual({ inputType: "url", url: "https://jobs.example.com/roles/123" });
    expect(() => CreateJobImportCommandSchema.parse({ inputType: "url", url: "https://user:password@jobs.example.com/roles/123" })).toThrow();
  });

  it("accepts a completed import without exposing stored source content", () => {
    expect(JobImportDetailSchema.parse({
      importId, inputType: "pasted_text", originalFilename: null,
      status: "completed", failureCode: null,
      createdAt: now, updatedAt: now,
      opportunity: {
        opportunityId, company: "示例科技", title: "高级前端工程师",
        location: null, postedAt: null, deadline: null,
        description: null,
        evidence: { sourcePostingId, sourcePostingVersionId, version: 1,
          sourceType: "user_import", retrievedAt: now, originalFilename: null,
          requestedUrl: null, finalUrl: null, canonicalUrl: null, pageClassification: null, sourceKind: null },
      },
    })).toBeDefined();
  });

  it("仅接受可回指原文并可确定性导出标准值的资格证据", () => {
    const output = JobNormalizerOutputSchema.parse({
      normalizerVersion: "fake-job-normalizer-v2",
      company: "示例科技",
      title: "高级前端工程师",
      location: null,
      postedAt: null,
      deadline: null,
      description: null,
      qualifications: {
        workMode: { value: "remote", evidence: { field: "workMode", path: "lines:3-3", value: "远程", rawValue: "远程", normalizedValue: "remote" } },
        relocationRequired: null,
        salary: null,
        seniority: null,
        education: null,
        languages: null,
        workEligibility: null,
        industry: null,
        employmentType: null,
        requiredSkills: null,
      }, fieldEvidence: [
        { field: "company", path: "lines:1-1", rawValue: "示例科技", normalizedValue: "示例科技" },
        { field: "title", path: "lines:2-2", rawValue: "高级前端工程师", normalizedValue: "高级前端工程师" },
      ],
    });
    const source = "公司：示例科技\n标题：高级前端工程师\n工作方式：远程";
    expect(validateJobNormalizerOutput(source, output)).toBe(true);
    expect(validateJobNormalizerOutput(source.replace("远程", "现场"), output)).toBe(false);
    expect(validateJobNormalizerOutput(source, { ...output, qualifications: { ...output.qualifications, workMode: { ...output.qualifications.workMode!, evidence: { ...output.qualifications.workMode!.evidence, path: "lines:1-1" } } } })).toBe(false);
  });

  it("为提供商生成无自由键的递归 strict JSON Schema", () => {
    const schema = JobNormalizerModelOutputSchema.toJSONSchema() as any;
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return true;
      const value = node as { type?: unknown; additionalProperties?: unknown; properties?: Record<string, unknown>; required?: unknown };
      if (value.type === "object" && (value.additionalProperties !== false || !Array.isArray(value.required) || Object.keys(value.properties ?? {}).some((key) => !(value.required as string[]).includes(key)))) return false;
      return Object.values(value).every((child) => Array.isArray(child) ? child.every(visit) : visit(child));
    };
    expect(visit(schema)).toBe(true);
  });

  it("treats legacy normalized data without qualifications as missing fields", () => {
    expect(JobNormalizerOutputSchema.parse({
      normalizerVersion: "fake-job-normalizer-v1", company: null, title: null, location: null,
      postedAt: null, deadline: null, description: null,
    }).qualifications).toEqual({
      workMode: null, relocationRequired: null, salary: null, seniority: null, education: null,
      languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null,
    });
  });
});
