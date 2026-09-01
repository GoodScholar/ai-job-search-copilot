import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const devSecret = "issue-2-e2e-dev-auth-shared-secret";
const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function session(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": devSecret }, data: { subject } });
  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function seedProfileAndTarget(request: APIRequestContext, token: string): Promise<void> {
  const facts = [
    { factType: "education", factValue: { summary: "本科" } },
    { factType: "language", factValue: { name: "英语", level: "C1" } },
    { factType: "work_eligibility", factValue: { summary: "中国工作许可" } },
    { factType: "skill", factValue: { name: "TypeScript" } },
  ];
  for (let expectedVersion = 0; expectedVersion < facts.length; expectedVersion += 1) {
    const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: { authorization: `Bearer ${token}` }, data: { expectedVersion, ...facts[expectedVersion]! } });
    expect(response.status()).toBe(201);
  }
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, { headers: { authorization: `Bearer ${token}` }, data: {
    priority: "primary", constraints: {
      roleFamily: "frontend", seniority: null, locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    },
  } });
  expect(target.status()).toBe(201);
}

async function signIn(page: Page, request: APIRequestContext, project: string): Promise<void> {
  const token = await session(request, `job-triage-${project}-${suffix}`);
  await seedProfileAndTarget(request, token);
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/jobs/import");
  await expect(page.getByRole("heading", { name: "导入岗位" })).toBeVisible();
}

async function importAndEvaluate(page: Page, content: string, expected: string, project: string): Promise<void> {
  const title = content.match(/^#\s+(.+)$/mu)?.[1];
  await page.getByRole("textbox", { name: "岗位描述" }).fill(content);
  const submit = page.getByRole("button", { name: "导入岗位" });
  if (project === "Mobile Safari") await submit.tap(); else await submit.click();
  await expect(page.getByRole("status")).toHaveText("导入完成", { timeout: 15_000 });
  if (title) await expect(page.locator(".job-import-opportunity")).toContainText(title);
  const assess = page.getByRole("button", { name: "开始资格与粗排" });
  if (project === "Mobile Safari") await assess.tap(); else await assess.click();
  await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
}

test("真实运行时持久化 hard fail、unknown 与 pass 三条岗位评估路径", async ({ page, request }, testInfo) => {
  await signIn(page, request, testInfo.project.name);
  if (testInfo.project.name === "Desktop Chrome") {
    await page.getByRole("textbox", { name: "岗位描述" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "导入岗位" })).toBeFocused();
  }

  await importAndEvaluate(page, ["# 现场前端", "公司：示例科技", "地点：上海", "工作方式：现场"].join("\n"), "不符合资格门槛", testInfo.project.name);
  await importAndEvaluate(page, ["# 待确认前端", "公司：示例科技", "地点：上海", "工作方式：远程"].join("\n"), "待补充证据", testInfo.project.name);
  await importAndEvaluate(page, [
    "# frontend engineer", "公司：示例科技", "地点：上海", "截止日期：2026-09-12T00:00:00.000Z", "工作方式：远程", "是否需要搬迁：否",
    "学历：本科", "语言：英语(C1)", "工作资格：中国工作许可", "必备技能：TypeScript",
  ].join("\n"), "符合资格门槛", testInfo.project.name);

  await page.reload();
  await expect(page.getByText("符合资格门槛", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/粗排总分/)).toBeVisible();
  const controls = page.locator(".job-import-workbench .workbench-touch-target");
  expect(await controls.evaluateAll((items) => items.every((item) => item.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
