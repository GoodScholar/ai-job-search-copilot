import { describe, expect, it } from "vitest";
import {
  CAREER_PRIVACY_SCAN_VERSION,
  inspectCareerDocumentPrivacy,
} from "./career-document-privacy";

describe("inspectCareerDocumentPrivacy", () => {
  it("finds common private information and replaces it with semantic placeholders", () => {
    const markdown = [
      "# 姓名：张三",
      "邮箱：secret@example.com",
      "电话：138 0000 0000",
      "身份证：11010519491231002X",
      "详细住址：北京市朝阳区示例路 1 号",
      "微信：zhangsan_jobs",
      "![个人照片](https://example.com/avatar.png)",
    ].join("\n");

    const result = inspectCareerDocumentPrivacy(markdown);

    expect(result.version).toBe(CAREER_PRIVACY_SCAN_VERSION);
    expect(result.findings.map(({ kind, line }) => ({ kind, line }))).toEqual([
      { kind: "name", line: 1 },
      { kind: "email", line: 2 },
      { kind: "phone", line: 3 },
      { kind: "identity_number", line: 4 },
      { kind: "address", line: 5 },
      { kind: "social_account", line: 6 },
      { kind: "image_or_qr", line: 7 },
    ]);
    expect(result.sanitizedMarkdown).toBe([
      "# 姓名：[姓名]",
      "邮箱：[邮箱]",
      "电话：[手机号]",
      "身份证：[证件号码]",
      "详细住址：[详细住址]",
      "微信：[社交账号]",
      "[照片或二维码]",
    ].join("\n"));
  });

  it("does not rewrite companies, roles, dates, projects, achievements, or ordinary headings", () => {
    const markdown = [
      "# 个人简历",
      "# 软件工程师",
      "# 字节跳动",
      "# 华为",
      "# 苏宁",
      "## 工作经历",
      "- AI 应用工程师｜示例科技｜2024-至今",
      "## 项目经历",
      "- Job Copilot：将解析耗时降低 35%",
      "![项目架构图](architecture.png)",
      '<img src="system-diagram.png" alt="系统架构图">',
      "## 技能",
      "- TypeScript",
    ].join("\n");

    expect(inspectCareerDocumentPrivacy(markdown)).toEqual({
      version: CAREER_PRIVACY_SCAN_VERSION,
      findings: [],
      sanitizedMarkdown: markdown,
    });
  });

  it("redacts only a labeled name when the role follows on the same line", () => {
    expect(inspectCareerDocumentPrivacy("姓名：张三｜AI 应用工程师\n- 2024-至今").sanitizedMarkdown)
      .toBe("姓名：[姓名]｜AI 应用工程师\n- 2024-至今");
    expect(inspectCareerDocumentPrivacy("姓名：张三 · AI 应用工程师").sanitizedMarkdown)
      .toBe("姓名：[姓名] · AI 应用工程师");
    expect(inspectCareerDocumentPrivacy([
      "姓名：张三 - AI 应用工程师",
      "详细住址：北京市朝阳区示例路 1 号 - 可远程",
      "微信：secret_handle - 工作账号",
    ].join("\n")).sanitizedMarkdown).toBe([
      "姓名：[姓名] - AI 应用工程师",
      "详细住址：[详细住址] - 可远程",
      "微信：[社交账号] - 工作账号",
    ].join("\n"));
    expect(inspectCareerDocumentPrivacy([
      "姓名：张三，AI 工程师",
      "详细住址：北京市朝阳区示例路 1 号；可远程",
      "微信：secret_handle/工作账号",
    ].join("\n")).sanitizedMarkdown).toBe([
      "姓名：[姓名]，AI 工程师",
      "详细住址：[详细住址]",
      "微信：[社交账号]",
    ].join("\n"));
  });

  it("detects an unlabeled H1 name only in a personal resume context", () => {
    const cases = [
      "# 张三\nsecret@example.com\n## 技能\n- TypeScript",
      "# 刘伟\n微信：secret_handle\n## 技能\n- TypeScript",
      "# 李雷\n身份证：11010519491231002X\n## 技能\n- TypeScript",
      "# 王芳\n详细住址：北京市朝阳区示例路 1 号\n## 技能\n- TypeScript",
      "# 欧阳娜娜\n邮箱：secret@example.com\n## 工作经历\n- 示例科技",
      "# 侯伟\n电话：13800000000\n## 教育经历\n- 示例大学",
    ];

    for (const markdown of cases) {
      expect(inspectCareerDocumentPrivacy(markdown).sanitizedMarkdown).toMatch(/^# \[姓名\]/u);
    }

    const companyHeading = "# 苏宁\n邮箱：secret@example.com\n## 招聘岗位\n- AI 工程师";
    expect(inspectCareerDocumentPrivacy(companyHeading).sanitizedMarkdown)
      .toBe("# 苏宁\n邮箱：[邮箱]\n## 招聘岗位\n- AI 工程师");

    for (const company of ["荣耀", "安踏", "徐工", "安居客", "高德"]) {
      const companyPage = `# ${company}\n联系方式：secret@example.com\n## 招聘岗位\n- AI 工程师`;
      expect(inspectCareerDocumentPrivacy(companyPage).sanitizedMarkdown)
        .toBe(`# ${company}\n联系方式：[邮箱]\n## 招聘岗位\n- AI 工程师`);
    }
  });

  it("does not treat a resume section H1 itself as an unlabeled name", () => {
    for (const markdown of [
      "# 工作经历\n邮箱：secret@example.com",
      "# 个人简介\n电话：13800000000",
    ]) {
      expect(inspectCareerDocumentPrivacy(markdown).sanitizedMarkdown)
        .toBe(markdown.replace("secret@example.com", "[邮箱]").replace("13800000000", "[手机号]"));
    }
  });

  it("redacts address and social values through ambiguous punctuation", () => {
    expect(inspectCareerDocumentPrivacy([
      "详细住址：北京市朝阳区，建国路88号",
      "微信：secret/secondary",
    ].join("\n")).sanitizedMarkdown).toBe([
      "详细住址：[详细住址]",
      "微信：[社交账号]",
    ].join("\n"));
  });

  it("detects linked and HTML photos or QR codes", () => {
    const markdown = [
      "[二维码](https://example.com/qr)",
      '<img\nsrc="avatar.png"\nalt="个人照片">',
    ].join("\n");
    const result = inspectCareerDocumentPrivacy(markdown);

    expect(result.findings.map(({ kind }) => kind)).toEqual(["image_or_qr", "image_or_qr"]);
    expect(result.sanitizedMarkdown).toBe("[照片或二维码]\n[照片或二维码]\n\n");
    expect(result.sanitizedMarkdown.split("\n")).toHaveLength(markdown.split("\n").length);
  });

  it("detects reference-style profile images and LinkedIn profile links", () => {
    const result = inspectCareerDocumentPrivacy([
      "![头像][photo]",
      "[photo]: https://example.com/zhangsan/avatar.png",
      "LinkedIn: https://www.linkedin.com/in/secret-profile",
    ].join("\n"));

    expect(result.findings.map(({ kind }) => kind)).toEqual(["image_or_qr", "image_or_qr", "social_account"]);
    expect(result.sanitizedMarkdown).toBe("[照片或二维码]\n[照片或二维码]\nLinkedIn: [社交账号]");
  });

  it("detects collapsed and shortcut profile image references and their definitions", () => {
    const result = inspectCareerDocumentPrivacy([
      "![头像][]",
      "[头像]: https://example.com/secret-collapsed.png",
      "![个人照片]",
      "[个人照片]: https://example.com/secret-shortcut.png",
    ].join("\n"));

    expect(result.findings.map(({ kind }) => kind)).toEqual([
      "image_or_qr",
      "image_or_qr",
      "image_or_qr",
      "image_or_qr",
    ]);
    expect(result.sanitizedMarkdown).toBe([
      "[照片或二维码]",
      "[照片或二维码]",
      "[照片或二维码]",
      "[照片或二维码]",
    ].join("\n"));
  });

  it("reports masked previews without returning the detected raw values", () => {
    const markdown = "姓名：李雷\n邮箱：li.lei@example.com\n电话：13912345678";

    const result = inspectCareerDocumentPrivacy(markdown);
    const serializedFindings = JSON.stringify(result.findings);

    expect(serializedFindings).not.toContain("李雷");
    expect(serializedFindings).not.toContain("li.lei@example.com");
    expect(serializedFindings).not.toContain("13912345678");
    expect(result.findings.map((finding) => finding.maskedPreview)).toEqual([
      "李*",
      "l***@example.com",
      "139****5678",
    ]);
  });

  it("preserves line count and replaces every occurrence deterministically", () => {
    const markdown = "邮箱：one@example.com\r\n备用邮箱：one@example.com\r\n- TypeScript";

    const first = inspectCareerDocumentPrivacy(markdown);
    const second = inspectCareerDocumentPrivacy(markdown);

    expect(first).toEqual(second);
    expect(first.sanitizedMarkdown).toBe("邮箱：[邮箱]\r\n备用邮箱：[邮箱]\r\n- TypeScript");
    expect(first.sanitizedMarkdown.split(/\r?\n/)).toHaveLength(markdown.split(/\r?\n/).length);
  });
});
