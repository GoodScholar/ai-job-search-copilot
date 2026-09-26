import { expect, it } from "vitest";
import { formatEvidence } from "./formatters.js";

it("保留冻结来源路径，并为行业原文补充可读字段语义", () => {
  expect(formatEvidence([{ id: "job:1", value: "行业：人工智能", provenance: {
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000001", field: "industry", path: "lines:11-11", originalValue: "人工智能", normalizedValue: "人工智能",
  } }])).toBe("lines:11-11：行业：人工智能");
});

it("保留历史证据的原文展示", () => {
  expect(formatEvidence([{ id: "job:old", value: "行业：人工智能", provenance: {
    sourcePostingVersionId: "00000000-0000-4000-8000-000000000001", field: "industry", path: "行业", originalValue: "AI 基础设施", normalizedValue: "人工智能",
  } }])).toBe("行业：AI 基础设施");
});
