import { describe, expect, it } from "vitest";
import * as workbench from "./workbench";

type Schema = {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: boolean };
};

const schema = (name: string): Schema => {
  expect(workbench).toHaveProperty(name);
  return (workbench as unknown as Record<string, Schema>)[name];
};

const steps = [
  {
    id: "career_materials",
    title: "准备可用职业资料",
    status: "needs_action",
    stateLabel: "需要处理",
    impact: "系统需要从真实职业资料建立可追溯来源。",
    action: { label: "导入职业资料", href: "/profile" },
  },
  {
    id: "profile_evidence",
    title: "建立可信求职画像",
    status: "in_progress",
    stateLabel: "正在建立",
    impact: "求职画像需要经过核验。",
    action: { label: "查看职业资料", href: "/profile" },
  },
  {
    id: "primary_target",
    title: "明确主要求职方向",
    status: "waiting",
    stateLabel: "等待设置",
    impact: "主要求职方向会决定推荐范围。",
    action: { label: "设置求职方向", href: "/profile/targets" },
  },
  {
    id: "job_sources",
    title: "接通真实岗位来源",
    status: "needs_action",
    stateLabel: "需要处理",
    impact: "岗位来源决定可发现的真实机会。",
    action: { label: "管理岗位来源", href: "/profile/targets/target-1/watchlist" },
  },
  {
    id: "run_readiness",
    title: "确认今天可以开始",
    status: "waiting",
    stateLabel: "等待确认",
    impact: "运行前需要确认模型连接和策略。",
    action: { label: "确认运行策略", href: "/profile/run-policy" },
  },
  {
    id: "first_result",
    title: "获得第一份推荐结果",
    status: "completed",
    stateLabel: "已完成",
    impact: "第一份推荐结果会展示在首页。",
    action: { label: "查看运行结果", href: "/home?runId=run-1#agent-run" },
  },
] as const;

const activeJourney = {
  status: "active",
  steps,
  currentStepId: "career_materials",
  completedAt: null,
};

const home = (firstRecommendationJourney: unknown) => ({
  account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
  summary: {
    todayRecommendations: 0,
    pendingFacts: 0,
    activeAgentRuns: 0,
    failedAgentRuns: 0,
    sourceFailures: 0,
    pendingDecisions: 0,
    applications: 0,
    applicationsAvailable: false,
  },
  firstRecommendationJourney,
});

describe("首次推荐旅程契约", () => {
  it("固定六个步骤 ID、标题与四种步骤状态", () => {
    const stepSchema = schema("FirstRecommendationJourneyStepSchema");
    const stepIdSchema = schema("FirstRecommendationJourneyStepIdSchema");

    expect(stepSchema.parse(steps[0])).toEqual(steps[0]);
    for (const step of steps) expect(stepIdSchema.parse(step.id)).toBe(step.id);
    expect(stepSchema.safeParse({ ...steps[0], title: "职业资料准备" }).success).toBe(false);
    expect(stepSchema.safeParse({ ...steps[0], status: "blocked" }).success).toBe(false);
  });

  it("只接受安全的中文展示字段与单斜杠站内入口", () => {
    const stepSchema = schema("FirstRecommendationJourneyStepSchema");

    for (const href of ["/profile", "/profile/targets", "/profile/targets/target-1/watchlist", "/profile/model-connection", "/profile/run-policy", "/home", "/home?runId=run-1#agent-run", "/not-hardcoded"]) {
      expect(stepSchema.safeParse({ ...steps[0], action: { ...steps[0].action, href } }).success).toBe(true);
    }

    for (const invalid of [
      { ...steps[0], title: "   " },
      { ...steps[0], stateLabel: "needs action" },
      { ...steps[0], impact: "x".repeat(501) },
      { ...steps[0], action: { label: "导入职业资料", href: "//example.test" } },
      { ...steps[0], action: { label: "导入职业资料", href: "https://example.test" } },
      { ...steps[0], action: { label: "导入", href: "/profile", extra: true } },
      { ...steps[0], extra: true },
    ]) {
      expect(stepSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("按状态分支要求完整有序步骤、当前步骤和完成时间", () => {
    const journeySchema = schema("FirstRecommendationJourneySchema");

    expect(journeySchema.parse(activeJourney)).toEqual(activeJourney);
    expect(journeySchema.parse({ ...activeJourney, status: "dismissed" })).toEqual({ ...activeJourney, status: "dismissed" });
    expect(journeySchema.parse({ status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" }))
      .toEqual({ status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" });

    for (const invalid of [
      { ...activeJourney, steps: [...steps].reverse() },
      { ...activeJourney, steps: steps.slice(0, 5) },
      { ...activeJourney, currentStepId: null },
      { status: "completed", steps: [], currentStepId: null, completedAt: null },
      { status: "completed", steps, currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" },
      { ...activeJourney, completedAt: "2026-09-06T12:00:00.000Z" },
      { ...activeJourney, extra: true },
    ]) {
      expect(journeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("严格区分访问和关闭命令，并提供最小交互快照", () => {
    const commandSchema = schema("FirstRecommendationJourneyInteractionCommandSchema");
    const interactionSchema = schema("FirstRecommendationJourneyInteractionSchema");

    expect(commandSchema.parse({ action: "visit_step", stepId: "career_materials", expectedVersion: 0 }))
      .toEqual({ action: "visit_step", stepId: "career_materials", expectedVersion: 0 });
    expect(commandSchema.parse({ action: "dismiss", expectedVersion: 1 }))
      .toEqual({ action: "dismiss", expectedVersion: 1 });
    expect(interactionSchema.parse({ version: 0, dismissedAt: null, lastVisitedStep: "career_materials" }))
      .toEqual({ version: 0, dismissedAt: null, lastVisitedStep: "career_materials" });

    for (const invalid of [
      { action: "visit_step", stepId: "career_materials", expectedVersion: -1 },
      { action: "visit_step", stepId: "career_materials", expectedVersion: 0, userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
      { action: "dismiss", expectedVersion: 1, stepId: "career_materials" },
      { action: "dismiss", expectedVersion: 1.5 },
    ]) {
      expect(commandSchema.safeParse(invalid).success).toBe(false);
    }
    expect(interactionSchema.safeParse({ version: 0, dismissedAt: null, lastVisitedStep: null, userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }).success).toBe(false);
  });

  it("要求工作台首页始终包含首次推荐旅程", () => {
    const homeSchema = schema("WorkbenchHomeSchema");

    expect(homeSchema.parse(home(activeJourney))).toEqual(home(activeJourney));
    expect(homeSchema.safeParse({
      account: home(activeJourney).account,
      summary: home(activeJourney).summary,
    }).success).toBe(false);
  });
});
