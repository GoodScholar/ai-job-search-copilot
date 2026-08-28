import JSZip from "jszip";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function createDocx(paragraphs: string[], options: { embeddedMedia?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels")!.file(".rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const word = zip.folder("word")!;
  word.file("document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escaped(paragraph)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  if (options.embeddedMedia) word.folder("media")!.file("private-photo.png", Buffer.from("private-image-bytes-not-for-upload"));
  return Buffer.from(await zip.generateAsync({ type: "arraybuffer" }));
}

async function createDevSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function signInWithIsolatedAccount(page: Page, request: APIRequestContext, scope: string): Promise<void> {
  const token = await createDevSession(request, `docx-conflict-${scope}-${runSuffix}`);
  await page.context().addCookies([{
    name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  }]);
  await page.goto("/profile");
}

async function uploadDocx(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string[]> {
  const detailRoute = "**/api/career-imports/*";
  await page.route(detailRoute, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const input = page.getByLabel("选择 Markdown、DOCX 或 PDF 职业资料");
  try {
    await input.setInputFiles(file);
    const confirmation = page.getByLabel(/我已检查该文件/);
    await expect(confirmation).not.toBeChecked();
    await confirmation.check();
    await expect(page.getByRole("button", { name: "上传并解析" })).toBeEnabled();
    await page.getByRole("button", { name: "上传并解析" }).click();
    const history: string[] = [];
    await expect.poll(async () => {
      const status = await page.getByRole("status").textContent();
      if (status && history.at(-1) !== status) history.push(status);
      return history.some((entry) => /等待解析|解析中/.test(entry));
    }, { timeout: 15_000 }).toBe(true);
    await expect(page.getByRole("status")).toHaveText("解析完成", { timeout: 15_000 });
    history.push("解析完成");
    return history;
  } finally {
    await page.unroute(detailRoute);
  }
}

test("DOCX 浏览器脱敏副本经过队列处理后显示段落证据、跨文档冲突并可解决", async ({ page, request }, testInfo) => {
  await signInWithIsolatedAccount(page, request, testInfo.project.name);
  const first = { name: "career-one.docx", mimeType: docxMime, buffer: await createDocx(["## 工作经历", "- AI 工程师｜示例科技｜2023"]) };
  const incoming = { name: "career-two.docx", mimeType: docxMime, buffer: await createDocx(["## 工作经历", "- AI 工程师｜示例科技｜2024"]) };

  const firstStatuses = await uploadDocx(page, first);
  expect(firstStatuses).toEqual(expect.arrayContaining([expect.stringMatching(/等待解析|解析中/), "解析完成"]));
  await expect(page.getByText("第 2 段")).toBeVisible();
  const incomingStatuses = await uploadDocx(page, incoming);
  expect(incomingStatuses).toEqual(expect.arrayContaining([expect.stringMatching(/等待解析|解析中/), "解析完成"]));

  await expect(page.getByRole("heading", { name: "职业事实冲突" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("日期不一致 · 待处理")).toBeVisible();
  await expect(page.getByText(/已有（career-one\.docx）/)).toBeVisible();
  await expect(page.getByText(/新导入（career-two\.docx）/)).toBeVisible();
  await expect(page.getByText("第 2-2 段")).toHaveCount(2);
  await page.getByRole("button", { name: /career-one\.docx/ }).click();
  await expect(page.getByRole("heading", { name: "职业事实冲突" })).toBeVisible();
  await expect(page.getByText(/已有（career-one\.docx）/)).toBeVisible();
  await expect(page.getByRole("button", { name: /确认 AI 工程师/ })).toHaveCount(0);
  await page.getByRole("button", { name: "采用已有" }).click();
  await expect(page.getByText("日期不一致 · 已解决")).toBeVisible();
  await expect(page.getByRole("button", { name: "采用已有" })).toHaveCount(0);
  await expect(page.getByText("版本 1", { exact: true })).toBeVisible();
  await expect(page.getByText("AI 工程师｜示例科技｜2023", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("日期不一致 · 已解决")).toBeVisible();
  await expect(page.getByText("AI 工程师｜示例科技｜2023", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采用已有" })).toHaveCount(0);
});

test("含嵌入媒体的 DOCX 在浏览器先进入隐私确认，处理副本不显示原媒体字节", async ({ page, request }, testInfo) => {
  await signInWithIsolatedAccount(page, request, `${testInfo.project.name}-media`);
  const mediaOnly = {
    name: "photo-resume.docx",
    mimeType: docxMime,
    buffer: await createDocx(["## 工作经历", "- AI 工程师｜示例科技｜2024"], { embeddedMedia: true }),
  };

  await page.getByLabel("选择 Markdown、DOCX 或 PDF 职业资料").setInputFiles(mediaOnly);
  await expect(page.getByText("发现 1 项敏感信息", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "仅上传脱敏副本（原件不离开浏览器）" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "保留受保护原件（下游仍只使用脱敏副本）" })).toBeVisible();
  await page.getByText("查看脱敏处理副本", { exact: true }).click();
  const processingCopy = page.locator(".profile-privacy-preview pre");
  await expect(processingCopy).toContainText("[照片或二维码]");
  await expect(processingCopy).not.toContainText("private-image-bytes-not-for-upload");
  await page.getByRole("radio", { name: "保留受保护原件（下游仍只使用脱敏副本）" }).check();
  await page.getByRole("button", { name: "上传并解析" }).click();
  await expect(page.getByRole("status")).toHaveText("解析完成", { timeout: 15_000 });
  await expect(page.getByText("原件受保护，下游使用脱敏副本")).toBeVisible();
});
