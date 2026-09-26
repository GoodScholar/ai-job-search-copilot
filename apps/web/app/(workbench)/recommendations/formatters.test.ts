import { describe, expect, it } from "vitest";
import { formatProfileEvidenceValue } from "./formatters";

describe("formatProfileEvidenceValue", () => {
  it("将冻结的画像事实与目标枚举转为求职者可读文本", () => {
    expect(formatProfileEvidenceValue('{"name":"英语","level":"C1"}')).toBe("英语 · C1");
    expect(formatProfileEvidenceValue('{"summary":"中国工作许可"}')).toBe("中国工作许可");
    expect(formatProfileEvidenceValue("已确认的地点/工作方式约束：remote, not_willing, 上海")).toBe("已确认的地点/工作方式约束：远程、不可搬迁、上海");
  });
});
