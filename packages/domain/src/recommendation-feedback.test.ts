import { describe, expect, it } from "vitest";
import { createRecommendationFeedbackCommands } from "./recommendation-feedback";

describe("推荐反馈命令", () => {
  it("为无事件推荐项派生 pending，并且只把有效字段传给决策记录", async () => {
    const calls: unknown[] = [];
    const commands = createRecommendationFeedbackCommands({
      db: { transaction: async (callback: (tx: any) => unknown) => callback({ marker: "transaction" }) } as any,
      id: () => "00000000-0000-4000-8000-000000000010", clock: () => new Date("2026-09-02T00:00:00.000Z"),
      transaction: async (_tx, input) => { calls.push(input); return { decision: { status: "saved", version: 1 }, proposal: null }; },
    });
    await expect(commands.recordDecision({ userId: "00000000-0000-4000-8000-000000000001", recommendationListId: "00000000-0000-4000-8000-000000000002", recommendationListItemId: "00000000-0000-4000-8000-000000000003", command: { decision: "saved", expectedVersion: 0, idempotencyKey: "00000000-0000-4000-8000-000000000005" } })).resolves.toEqual({ decision: { status: "saved", version: 1 }, proposal: null });
    expect(calls).toEqual([expect.objectContaining({ decision: "saved", reason: null, note: null })]);
  });
});
