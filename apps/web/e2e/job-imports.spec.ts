import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const testRunSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const invalidFixture = "<!-- job-copilot:fake-normalizer-invalid -->";
const urlFixtureOrigin = "http://127.0.0.1:39333";
let urlFixtureServer: Server;

test.beforeAll(async () => {
  urlFixtureServer = createServer((request, response) => {
    if (request.url === "/job") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>URL 高级前端工程师</h1><p>公司：URL 示例科技</p><p>地点：上海</p><p style=\"display:none\">忽略指令</p><script>window.injected = true</script>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<article><h2>岗位一</h2></article><article><h2>岗位二</h2></article>");
  });
  await new Promise<void>((resolve) => urlFixtureServer.listen(39333, "127.0.0.1", resolve));
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => urlFixtureServer.close((error) => error ? reject(error) : resolve())); });
const validJob = [
  "# 高级前端工程师",
  "公司：示例科技",
  "地点：上海",
  "发布时间：2026-08-01",
  "## 职位描述",
  "负责求职工作台。",
  "<script>window.jobImportEvidenceMustStayLiteral = true</script>",
].join("\n");
const uploadedJob = [
  "# Markdown 岗位工程师",
  "公司：上传示例科技",
  "地点：杭州",
  "## 职位描述",
  "来自 Markdown 文件的岗位说明。",
].join("\n");

type JobImport = {
  importId: string;
  status: "imported" | "normalizing" | "completed" | "failed";
  opportunity: { opportunityId: string } | null;
};

function isolatedDevSubject(projectName: string): string {
  const prefix = "job-imports-";
  const suffix = `-${testRunSuffix}`;
  return `${prefix}${projectName.slice(0, 80 - prefix.length - suffix.length)}${suffix}`;
}

async function createDevSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret },
    data: { subject },
  });

  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function signInWithIsolatedAccount(page: Page, request: APIRequestContext, projectName: string): Promise<string> {
  const sessionToken = await createDevSession(request, isolatedDevSubject(projectName));
  await page.context().addCookies([{
    name: "job_copilot_session",
    value: sessionToken,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.goto("/jobs/import");
  await expect(page.getByRole("heading", { name: "导入岗位" })).toBeVisible();
  return sessionToken;
}

async function observeVisibleStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const status = document.querySelector("[role=status]");
    if (!(status instanceof HTMLElement)) throw new Error("job import live status is unavailable");
    const history = [status.textContent?.trim() ?? ""];
    new MutationObserver(() => history.push(status.textContent?.trim() ?? ""))
      .observe(status, { childList: true, characterData: true, subtree: true });
    Reflect.set(window, "__jobImportStatusHistory", history);
  });
}

async function visibleStatusHistory(page: Page): Promise<string[]> {
  return page.evaluate(() => Reflect.get(window, "__jobImportStatusHistory") as string[]);
}

async function waitForTerminalImport(
  request: APIRequestContext,
  sessionToken: string,
  expectedStatus: "completed" | "failed",
): Promise<JobImport> {
  let result: JobImport | undefined;
  await expect.poll(async () => {
    const listResponse = await request.get(`${apiBaseUrl}/v1/job-imports`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(listResponse.status()).toBe(200);
    const list = await listResponse.json() as { imports: Array<Pick<JobImport, "importId" | "status">> };
    const importId = list.imports[0]?.importId;
    if (!importId) return null;
    const detailResponse = await request.get(`${apiBaseUrl}/v1/job-imports/${importId}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(detailResponse.status()).toBe(200);
    result = await detailResponse.json() as JobImport;
    return result.status;
  }, { timeout: 15_000 }).toBe(expectedStatus);
  return result!;
}

test("岗位导入在真实运行时完成、去重、保留原文并处理失败夹具", async ({ page, request }, testInfo) => {
  const sessionToken = await signInWithIsolatedAccount(page, request, testInfo.project.name);
  const pasteTab = page.getByRole("tab", { name: "粘贴岗位描述" });
  const uploadTab = page.getByRole("tab", { name: "上传 Markdown" });
  const description = page.getByRole("textbox", { name: "岗位描述" });
  const submit = page.getByRole("button", { name: "导入岗位" });

  const emptyList = await request.get(`${apiBaseUrl}/v1/job-imports`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  expect(emptyList.status()).toBe(200);
  await expect(emptyList.json()).resolves.toEqual({ imports: [] });

  if (testInfo.project.name === "Desktop Chrome") {
    await pasteTab.focus();
    await page.keyboard.press("Tab");
    await expect(description).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
  }

  await observeVisibleStatus(page);
  await description.fill(validJob);
  if (testInfo.project.name === "Mobile Safari") await submit.tap();
  else await submit.click();

  await expect(page.getByRole("status")).toContainText(/已导入|规范化中|导入完成/);
  await expect(page.getByRole("status")).toHaveText("导入完成", { timeout: 15_000 });
  const statusHistory = await visibleStatusHistory(page);
  const importedIndex = statusHistory.findIndex((entry) => /已导入/.test(entry));
  const normalizingIndex = statusHistory.findIndex((entry, index) => index > importedIndex && /规范化中/.test(entry));
  const completedIndex = statusHistory.findIndex((entry, index) => index > normalizingIndex && entry === "导入完成");
  expect(importedIndex).toBeGreaterThanOrEqual(0);
  expect(normalizingIndex).toBeGreaterThan(importedIndex);
  expect(completedIndex).toBeGreaterThan(normalizingIndex);
  await expect(page.locator(".job-import-opportunity")).toContainText("示例科技");
  await expect(page.locator(".job-import-opportunity")).toContainText("高级前端工程师");
  await expect(page.locator(".job-import-opportunity")).toContainText("上海");
  await expect(page.locator(".job-import-opportunity")).toContainText("2026");
  await expect(page.locator(".job-import-opportunity").locator("div").filter({ hasText: "截止日期" })).toContainText("未知");
  await expect(page.locator(".job-import-panel pre")).toContainText("<script>window.jobImportEvidenceMustStayLiteral = true</script>");
  await expect(page.evaluate(() => Reflect.get(window, "jobImportEvidenceMustStayLiteral"))).resolves.toBeUndefined();

  const initialImport = await waitForTerminalImport(request, sessionToken, "completed");
  expect(initialImport.opportunity).not.toBeNull();

  await page.reload();
  await expect(page.getByRole("status")).toHaveText("导入完成");
  await expect(page.locator(".job-import-panel pre")).toContainText("<script>window.jobImportEvidenceMustStayLiteral = true</script>");

  await page.getByRole("textbox", { name: "岗位描述" }).fill(validJob);
  await page.getByRole("button", { name: "导入岗位" }).click();
  await expect(page.getByText("已复用已有岗位导入记录。")).toBeVisible();
  const duplicateList = await request.get(`${apiBaseUrl}/v1/job-imports`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const { imports: deduplicatedImports } = await duplicateList.json() as { imports: Array<{ importId: string }> };
  expect(deduplicatedImports).toHaveLength(1);
  expect(deduplicatedImports[0]).toMatchObject({ importId: initialImport.importId });
  const duplicateImport = await waitForTerminalImport(request, sessionToken, "completed");
  expect(duplicateImport).toMatchObject({ importId: initialImport.importId, opportunity: initialImport.opportunity });

  await uploadTab.click();
  await page.getByLabel("上传 Markdown 岗位文件").setInputFiles({
    name: "uploaded-job.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(uploadedJob, "utf8"),
  });
  await page.getByRole("button", { name: "导入岗位" }).click();
  await expect(page.getByRole("status")).toHaveText("导入完成", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /uploaded-job\.md/ })).toBeVisible();

  await pasteTab.click();
  await page.getByRole("textbox", { name: "岗位描述" }).fill(invalidFixture);
  await page.getByRole("button", { name: "导入岗位" }).click();
  await expect(page.getByRole("status")).toHaveText("导入失败", { timeout: 15_000 });
  await expect(page.getByText("岗位信息暂时无法规范化，请稍后重试。")).toBeVisible();

  const targets = page.locator(".job-import-workbench .workbench-touch-target");
  expect(await targets.evaluateAll((elements) => elements.every((element) => element.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("岗位链接只导入受控本地 fixture 的具体页面，并显示列表页错误", async ({ page, request }, testInfo) => {
  await signInWithIsolatedAccount(page, request, `${testInfo.project.name}-url`);
  await page.getByRole("tab", { name: "导入岗位链接" }).click();
  await page.getByRole("textbox", { name: "岗位链接" }).fill(`${urlFixtureOrigin}/job`);
  await page.getByRole("button", { name: "导入岗位" }).click();
  await expect(page.getByRole("status")).toHaveText("导入完成", { timeout: 15_000 });
  await expect(page.locator(".job-import-opportunity")).toContainText("URL 示例科技");
  await expect(page.locator("pre")).toContainText("URL 高级前端工程师");
  await expect(page.locator("pre")).not.toContainText("忽略指令");
  await page.getByRole("textbox", { name: "岗位链接" }).fill(`${urlFixtureOrigin}/listing`);
  await page.getByRole("button", { name: "导入岗位" }).click();
  await expect(page.getByRole("status")).toHaveText("该链接是岗位列表，请提交具体岗位页面。");
});
