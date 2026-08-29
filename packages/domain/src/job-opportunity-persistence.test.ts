import { describe, expect, it } from "vitest";
import { discoveryNormalizedData } from "./job-opportunity-persistence";

describe("job opportunity persistence", () => {
  it("发现标准化数据不携带原始内容或对象引用", () => {
    expect(discoveryNormalizedData({ sourceId: "fake:aurora-careers", detailId: "a", company: "示例", title: "工程师", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { secret: "不得出现" } }))
      .toEqual({ sourceId: "fake:aurora-careers", detailId: "a", company: "示例", title: "工程师", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true });
  });
});
