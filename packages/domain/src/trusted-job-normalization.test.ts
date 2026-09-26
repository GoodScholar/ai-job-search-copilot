import { describe, expect, it } from "vitest";
import { buildTrustedNormalizationContent } from "./trusted-job-normalization";

describe("受信 ATS 岗位归一化输入", () => {
  it("只从原始 Greenhouse payload 构造不可信内容，不回填展示或 watchlist 字段", () => {
    const content = buildTrustedNormalizationContent({
      sourceId: "greenhouse:example", detailId: "701", company: "展示公司", title: "展示岗位", location: "Shanghai",
      postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true,
      rawPayload: {
        title: "AI Engineer", location: { name: "北京" }, first_published: "2026-09-01T00:00:00.000Z",
        content: "<p>要求：TypeScript, SQL</p>\n<a href=\"https://untrusted.example/job\">详情</a>",
      },
    });

    expect(content).toBe([
      "标题：AI Engineer",
      "地点：北京",
      "发布时间：2026-09-01T00:00:00.000Z",
      "描述：<p>要求：TypeScript, SQL</p>\n<a href=\"https://untrusted.example/job\">详情</a>",
    ].join("\n"));
    expect(content).not.toContain("展示公司");
    expect(content).not.toContain("展示岗位");
  });

  it("保留受控 Fake 来源提供的 ATS 原始字段，使后续 normalizer 可验证其完整证据", () => {
    const content = buildTrustedNormalizationContent({
      sourceId: "fake:aurora-careers", detailId: "aurora-frontend-001", company: "展示公司", title: "展示岗位", location: "展示地点",
      postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true,
      rawPayload: {
        company_name: "曙光云图", title: "高级前端工程师", location: { name: "上海" }, first_published: "2026-08-20T00:00:00.000Z",
        content: "工作方式：远程\n是否需要搬迁：否\n必备技能：TypeScript",
      },
    });

    expect(content).toBe([
      "公司：曙光云图",
      "标题：高级前端工程师",
      "地点：上海",
      "发布时间：2026-08-20T00:00:00.000Z",
      "描述：工作方式：远程\n是否需要搬迁：否\n必备技能：TypeScript",
    ].join("\n"));
    expect(content).not.toContain("展示公司");
  });
});
