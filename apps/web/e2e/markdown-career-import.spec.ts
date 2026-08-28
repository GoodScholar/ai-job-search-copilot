import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const testRunSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const resume = [
  "# 姓名：张三", "邮箱：secret@example.test", "## 工作经历",
  "- AI 应用工程师｜示例科技｜2024-至今", "## 技能", "- TypeScript", "- React",
  "## 教育经历", "- 示例大学｜计算机科学｜2020", "## 项目经历",
  "- Job Copilot：构建证据驱动的求职工作流", "## 语言", "- 英语：专业工作水平",
  "## 成果", "- 将解析耗时降低 35%", "## 联系方式", "- 电话：13800000000",
].join("\n");
const resumeFile = { name: "career.md", mimeType: "text/markdown", buffer: Buffer.from(resume, "utf8") };
const sanitizedResume = [
  "# 姓名：[姓名]", "邮箱：[邮箱]", "## 工作经历",
  "- AI 应用工程师｜示例科技｜2024-至今", "## 技能", "- TypeScript", "- React",
  "## 教育经历", "- 示例大学｜计算机科学｜2020", "## 项目经历",
  "- Job Copilot：构建证据驱动的求职工作流", "## 语言", "- 英语：专业工作水平",
  "## 成果", "- 将解析耗时降低 35%", "## 联系方式", "- 电话：[手机号]",
].join("\n");
const sanitizedResumeFile = {
  name: "career.md",
  mimeType: "text/markdown",
  buffer: Buffer.from(sanitizedResume, "utf8"),
};

type CareerImportDetail = {
  importId: string;
  privacyStatus: "sanitized_only" | "sanitized_with_protected_original";
  facts: unknown[];
};

function isolatedDevSubject(scope: string): string {
  const prefix = "mci-";
  const suffix = `-${testRunSuffix}`;
  return `${prefix}${scope.slice(0, 80 - prefix.length - suffix.length)}${suffix}`;
}

async function createDevSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret },
    data: { subject },
  });

  expect(response.status()).toBe(201);
  const session = await response.json() as { sessionToken: string };
  expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return session.sessionToken;
}

async function signInWithIsolatedAccount(page: Page, request: APIRequestContext, projectName: string): Promise<void> {
  await page.goto("/login?returnTo=%2Fprofile");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/profile$/);

  const sessionToken = await createDevSession(request, isolatedDevSubject(projectName));
  await page.context().addCookies([{
    name: "job_copilot_session",
    value: sessionToken,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.goto("/profile");
}

async function browserBearer(page: Page): Promise<string> {
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "job_copilot_session");
  expect(sessionCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return sessionCookie!.value;
}

async function observeImportStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const status = document.querySelector("[role=status]");
    if (!(status instanceof HTMLElement)) throw new Error("career import status is unavailable");
    const statusHistory = [status.textContent?.trim() ?? ""];
    new MutationObserver(() => statusHistory.push(status.textContent?.trim() ?? ""))
      .observe(status, { childList: true, characterData: true, subtree: true });
    Reflect.set(window, "__careerImportStatusHistory", statusHistory);
  });
}

async function importStatusHistory(page: Page): Promise<string[]> {
  return page.evaluate(() => Reflect.get(window, "__careerImportStatusHistory") as string[]);
}

test("登录用户可导入、持久化并安全复用 Markdown 职业资料", async ({ page, request }, testInfo) => {
  await signInWithIsolatedAccount(page, request, testInfo.project.name);

  const bearer = await browserBearer(page);
  const emptyImportResponse = await request.get(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(emptyImportResponse.status()).toBe(200);
  await expect(emptyImportResponse.json()).resolves.toEqual({ imports: [] });

  const fileInput = page.getByLabel("选择 Markdown、DOCX 或 PDF 职业资料");
  const uploadButton = page.getByRole("button", { name: "上传并解析" });
  await expect(page.getByRole("navigation", { name: "求职工作台导航" })).toHaveText("首页推荐投递画像");
  if (testInfo.project.name === "Desktop Chrome") {
    await page.goto("/profile");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "AI Job Search Copilot" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "首页" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "画像" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "退出" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(fileInput).toBeFocused();
  }

  await fileInput.setInputFiles(resumeFile);
  await expect(page.getByText("发现 3 项敏感信息", { exact: true })).toBeVisible();
  await page.getByText("查看脱敏处理副本", { exact: true }).click();
  const privacyPreview = page.locator(".profile-privacy-preview pre");
  await expect(privacyPreview).toContainText("# 姓名：[姓名]");
  await expect(privacyPreview).toContainText("邮箱：[邮箱]");
  await expect(privacyPreview).toContainText("电话：[手机号]");
  const retainOriginal = page.getByLabel("保留受保护原件（下游仍只使用脱敏副本）");
  if (testInfo.project.name === "Mobile Safari") {
    await retainOriginal.tap();
  } else {
    await retainOriginal.click();
  }
  await expect(uploadButton).toBeEnabled();
  await observeImportStatus(page);
  if (testInfo.project.name === "Mobile Safari") {
    await uploadButton.tap();
  } else {
    await uploadButton.click();
  }

  await expect(page.getByRole("status")).toContainText(/等待解析|解析中|解析完成/);
  await expect(page.getByText("TypeScript", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("第 6 行", { exact: true })).toBeVisible();
  await expect(page.getByText("待确认", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近导入" })).toBeVisible();
  await expect(page.getByRole("button", { name: /career\.md/ })).toBeVisible();
  expect(await importStatusHistory(page)).toEqual(expect.arrayContaining([
    expect.stringMatching(/等待解析|解析中/),
  ]));

  const initialImportResponse = await request.get(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(initialImportResponse.status()).toBe(200);
  const { imports } = await initialImportResponse.json() as { imports: Array<{ importId: string }> };
  expect(imports).toHaveLength(1);
  const importId = imports[0]!.importId;
  const detailResponse = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json() as CareerImportDetail;
  expect(detail.privacyStatus).toBe("sanitized_with_protected_original");
  expect(detail.facts).toHaveLength(7);

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("解析完成");
  await expect(page.getByText("TypeScript", { exact: true })).toBeVisible();
  await expect(page.getByText("第 6 行", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /原件受保护，下游使用脱敏副本/ })).toBeVisible();

  const duplicateResponse = await request.post(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${bearer}` },
    multipart: {
      privacyMode: "retain_protected_original",
      file: sanitizedResumeFile,
      protectedOriginal: resumeFile,
    },
  });
  expect(duplicateResponse.status()).toBe(200);
  const duplicateImport = await duplicateResponse.json() as { importId: string; reused: boolean; status: string };
  expect(duplicateImport).toMatchObject({ importId, reused: true, status: "completed" });
  const duplicateDetailResponse = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(duplicateDetailResponse.status()).toBe(200);
  const duplicateDetail = await duplicateDetailResponse.json() as CareerImportDetail;
  expect(duplicateDetail.importId).toBe(importId);
  expect(duplicateDetail.facts).toHaveLength(detail.facts.length);

  const secondaryBearer = await createDevSession(request, `markdown-career-import-secondary-${testInfo.project.name}-${testRunSuffix}`);
  const hiddenResponse = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, {
    headers: { authorization: `Bearer ${secondaryBearer}` },
  });
  expect(hiddenResponse.status()).toBe(404);

  const [fileInputHeight, uploadButtonHeight] = await Promise.all([
    fileInput.evaluate((element) => element.getBoundingClientRect().height),
    uploadButton.evaluate((element) => element.getBoundingClientRect().height),
  ]);
  expect(fileInputHeight).toBeGreaterThanOrEqual(44);
  expect(uploadButtonHeight).toBeGreaterThanOrEqual(44);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto("/home");
  const summary = page.getByLabel("当前求职记录摘要");
  await expect(summary).toContainText("待确认事实7");
  const profileEntry = page.getByRole("link", { name: "查看待确认事实" });
  await expect(profileEntry).toBeVisible();
  await profileEntry.click();
  await expect(page).toHaveURL(/\/profile$/);
});

test("候选事实的确认、纠正、拒绝、并发冲突和刷新都保持可信画像边界", async ({ page, request }, testInfo) => {
  await signInWithIsolatedAccount(page, request, `profile-review-${testInfo.project.name}`);
  const bearer = await browserBearer(page);
  const importResponse = await request.post(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${bearer}` },
    multipart: { privacyMode: "sanitized_only", file: sanitizedResumeFile },
  });
  expect(importResponse.status()).toBe(202);

  await page.goto("/profile");
  await expect(page.getByRole("button", { name: "确认 TypeScript" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "确认 TypeScript" }).click();
  await expect(page.getByRole("button", { name: "确认 TypeScript" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "当前可信画像" })).toContainText("当前可信画像");
  await expect(page.locator(".profile-fact-list").last()).toContainText("TypeScript");

  await page.getByRole("button", { name: "纠正 React" }).click();
  await page.getByLabel("纠正后的内容").fill("React 19");
  await page.getByLabel("纠正原因").fill("实际使用的版本");
  await page.getByRole("button", { name: "保存纠正" }).click();
  await expect(page.getByRole("button", { name: "纠正 React" })).toHaveCount(0);
  await expect(page.locator(".profile-fact-list").last()).toContainText("React 19");

  await page.getByRole("button", { name: /^拒绝 英语/ }).click();
  await expect(page.getByRole("button", { name: /^拒绝 英语/ })).toHaveCount(0);

  const advanceResponse = await request.post(`${apiBaseUrl}/v1/profile/facts`, {
    headers: { authorization: `Bearer ${bearer}` },
    data: { expectedVersion: 3, factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" } },
  });
  expect(advanceResponse.status()).toBe(201);

  const staleConfirm = page.getByRole("button", { name: /^确认 / }).first();
  await staleConfirm.click();
  await expect(page.getByText("画像已在其他位置更新，请刷新后重试。")).toBeVisible();

  await page.reload();
  await expect(page.getByText("版本 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认 TypeScript" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "纠正 React" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^拒绝 英语/ })).toHaveCount(0);
  await staleConfirm.click();
  await expect(page.getByText("版本 5", { exact: true })).toBeVisible();
});
