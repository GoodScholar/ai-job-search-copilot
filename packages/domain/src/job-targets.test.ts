import { describe, expect, it } from "vitest";
import type { ProfileFact } from "@job-copilot/contracts/profile-review";
import { suggestJobTargetDirections } from "./job-targets";

const createdAt = "2026-08-28T12:00:00.000Z";
const factId = "ce6bf2b5-c1b6-4d2e-9988-7b52ac0a7c53";
const revisionId = "1e7a466e-d51a-42a0-a7e4-c47a8e5dbe08";

function fact(input: Pick<ProfileFact, "factType" | "factValue">): ProfileFact {
  return {
    factId,
    revisionId,
    source: "user_confirmed",
    candidateFactId: null,
    createdAt,
    ...input,
  } as ProfileFact;
}

describe("job target suggestions", () => {
  it("从当前可信画像事实给出可追溯、稳定排序的 MVP 方向建议", () => {
    const suggestions = suggestJobTargetDirections([
      fact({ factType: "skill", factValue: { name: "React" } }),
      fact({ factType: "skill", factValue: { name: "TypeScript" } }),
      fact({ factType: "project", factValue: { summary: "负责 AI 应用的生产交付" } }),
      fact({ factType: "experience", factValue: { summary: "搭建 Agent workflow 与工具调用" } }),
    ]);

    expect(suggestions.map(({ roleFamily }) => roleFamily)).toEqual([
      "Agent 工程师", "前端工程师", "全栈工程师", "AI 应用工程师",
    ]);
    expect(suggestions).toHaveLength(4);
    for (const suggestion of suggestions) {
      expect(suggestion.rationale).toMatch(/\S/u);
      expect(suggestion.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ factId, revisionId }),
      ]));
    }
  });

  it("在没有当前可信画像事实时不编造建议", () => {
    expect(suggestJobTargetDirections([])).toEqual([]);
  });
});
