import { describe, expect, it } from "vitest";
import {
  CreateJobTargetCommandSchema,
  DeactivateJobTargetCommandSchema,
  JobTargetOverviewSchema,
  ReviseJobTargetCommandSchema,
} from "./job-targets";

const id = () => crypto.randomUUID();
const now = "2026-08-28T00:00:00.000Z";

const constraints = () => ({
  roleFamily: "  AI 应用工程师  ",
  seniority: null,
  locations: ["上海", "北京"],
  workModes: ["hybrid", "remote"] as const,
  relocation: "conditional" as const,
  salary: { minimum: 30_000, maximum: 50_000, period: "month" as const, currency: "CNY" },
  industries: ["人工智能"],
  dealBreakers: {
    excludedCompanies: ["示例公司"],
    excludedIndustries: ["外包"],
    excludeOutsourcing: true,
    excludeDispatch: true,
    excludeHeadhunter: false,
    other: ["长期出差"],
  },
});

describe("求职目标 contracts", () => {
  it("严格解析并规范化完整概览", () => {
    expect(JobTargetOverviewSchema.parse({
      suggestions: [{
        suggestionId: id(), roleFamily: "AI 应用工程师", rationale: "已有 AI 应用项目经验",
        evidence: [{ factId: id(), revisionId: id(), label: "Agent workflow" }],
      }],
      targets: [{
        targetId: id(), version: 1, priority: "primary", state: "active", constraints: constraints(),
        createdAt: now, updatedAt: now,
      }],
    })).toMatchObject({
      suggestions: [{ roleFamily: "AI 应用工程师" }],
      targets: [{ version: 1, constraints: { roleFamily: "AI 应用工程师" } }],
    });
  });

  it("拒绝概览中的未知字段和不合法版本", () => {
    expect(JobTargetOverviewSchema.safeParse({ suggestions: [], targets: [], extra: true }).success).toBe(false);
    expect(JobTargetOverviewSchema.safeParse({
      suggestions: [],
      targets: [{ targetId: id(), version: -1, priority: "primary", state: "active", constraints: constraints(), createdAt: now, updatedAt: now }],
    }).success).toBe(false);
  });

  it("创建命令只接受优先级和约束", () => {
    expect(CreateJobTargetCommandSchema.parse({ priority: "secondary", constraints: constraints() })).toMatchObject({
      priority: "secondary", constraints: { roleFamily: "AI 应用工程师" },
    });
    expect(CreateJobTargetCommandSchema.safeParse({ priority: "primary", constraints: constraints(), state: "active" }).success).toBe(false);
  });

  it("修订和停用命令保留乐观并发边界", () => {
    expect(ReviseJobTargetCommandSchema.parse({ expectedVersion: 1, priority: "primary", constraints: constraints() }))
      .toMatchObject({ expectedVersion: 1, priority: "primary" });
    expect(ReviseJobTargetCommandSchema.safeParse({ expectedVersion: 1, priority: "primary", constraints: constraints(), targetId: id() }).success).toBe(false);
    expect(DeactivateJobTargetCommandSchema.parse({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(DeactivateJobTargetCommandSchema.safeParse({ expectedVersion: 1, state: "inactive" }).success).toBe(false);
  });

  it("拒绝超出求职目标约束边界的值", () => {
    expect(CreateJobTargetCommandSchema.safeParse({
      priority: "primary", constraints: { ...constraints(), locations: ["上海", "上海"] },
    }).success).toBe(false);
    expect(CreateJobTargetCommandSchema.safeParse({
      priority: "primary", constraints: { ...constraints(), salary: { minimum: 60_000, maximum: 50_000, period: "month", currency: "CNY" } },
    }).success).toBe(false);
    expect(CreateJobTargetCommandSchema.safeParse({
      priority: "primary", constraints: { ...constraints(), salary: { minimum: 1.5, maximum: null, period: "year", currency: "cny" } },
    }).success).toBe(false);
    expect(CreateJobTargetCommandSchema.safeParse({
      priority: "primary", constraints: { ...constraints(), roleFamily: " ", industries: Array.from({ length: 21 }, (_, index) => `行业${index}`) },
    }).success).toBe(false);
  });
});
