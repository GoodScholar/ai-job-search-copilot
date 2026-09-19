import { describe, expect, it } from "vitest";
import { JourneyMetricEventSchema } from "./journey-metrics";

const event = {
  version: "first-recommendation-metrics-v1", journeyId: "d9cd1c47-91e0-448a-a815-5e84dd3aa89a",
  eventKey: "a".repeat(64), type: "started", stage: "career_materials",
  occurredAt: "2026-09-19T00:00:00.000Z", elapsedMs: 0, terminalStatus: null,
  reasonCode: null, configuration: "valid",
};
describe("首次推荐旅程指标字段白名单", () => {
  it("接受最小事件，拒绝身份、职业内容、服务密钥和任意扩展字段", () => {
    expect(JourneyMetricEventSchema.parse(event)).toEqual(event);
    for (const key of ["userId", "email", "openid", "resume", "jobDescription", "modelOutput", "recording", "apiKey", "metadata"]) {
      expect(JourneyMetricEventSchema.safeParse({ ...event, [key]: "private" }).success).toBe(false);
    }
    expect(JourneyMetricEventSchema.safeParse({ ...event, reasonCode: "private provider response" }).success).toBe(false);
  });
});
