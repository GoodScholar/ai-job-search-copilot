import { describe, expect, it } from "vitest";
import { detectCareerFactConflict } from "./career-fact-conflicts";

describe("职业事实冲突", () => {
  it("仅在同一机构和角色强锚点下识别日期差异", () => {
    expect(detectCareerFactConflict(
      { factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2023-2024" } },
      { factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2024-至今" } },
    )).toEqual({ kind: "date" });
  });

  it.each([
    ["role", "AI 工程师｜示例科技｜2024", "全栈工程师｜示例科技｜2024", { kind: "role" }],
    ["organization", "AI 工程师｜示例科技｜2024", "AI 工程师｜另一科技｜2024", { kind: "organization" }],
  ])("识别同日期职业事件的 %s 差异", (_name, left, right, expected) => {
    expect(detectCareerFactConflict({ factType: "experience", factValue: { summary: left } }, { factType: "experience", factValue: { summary: right } })).toEqual(expected);
  });

  it("识别同一成果的指标差异而不猜测弱锚点", () => {
    expect(detectCareerFactConflict(
      { factType: "achievement", factValue: { summary: "将解析耗时降低 35%" } },
      { factType: "achievement", factValue: { summary: "将解析耗时降低 40%" } },
    )).toEqual({ kind: "metric" });
    expect(detectCareerFactConflict(
      { factType: "achievement", factValue: { summary: "35%" } },
      { factType: "achievement", factValue: { summary: "40%" } },
    )).toBeNull();
    expect(detectCareerFactConflict(
      { factType: "experience", factValue: { summary: "AI 工程师" } },
      { factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2024" } },
    )).toBeNull();
  });

  it("在相同专业和年份强锚点下识别教育机构差异", () => {
    expect(detectCareerFactConflict(
      { factType: "education", factValue: { summary: "示例大学｜计算机科学｜2020" } },
      { factType: "education", factValue: { summary: "另一大学｜计算机科学｜2020" } },
    )).toEqual({ kind: "organization" });
  });
});
