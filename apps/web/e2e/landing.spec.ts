import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("桌面首屏展示职业透镜关系、完整旅程和真实登录入口", async ({ page }, info) => {
  test.skip(info.project.name !== "Desktop Chrome", "仅在桌面验收首屏层级");
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "从值得投的机会，走向准备充分的面试。" })).toBeInViewport();
  await expect(page.getByLabel("机会、事实与决定的示例关系")).toContainText("已确认事实");
  await expect(page.getByLabel("机会、事实与决定的示例关系")).toContainText("有依据，再决定");
  await expect(page.getByRole("list", { name: "求职旅程" })).toBeInViewport();
  await expect(page.getByRole("main").getByRole("link", { name: "开始体验" })).toHaveAttribute("href", "/login?returnTo=%2Fhome");
});

test("390×844 保留标题、关系、旅程与可触达主行动", async ({ page }, info) => {
  test.skip(info.project.name !== "Mobile Safari", "仅在移动项目验收内容顺序");
  await page.goto("/");

  const heading = page.getByRole("heading", { level: 1, name: "从值得投的机会，走向准备充分的面试。" });
  const action = page.getByRole("main").getByRole("link", { name: "开始体验" });
  const relation = page.getByLabel("机会、事实与决定的示例关系");
  await expect(heading).toBeInViewport();
  await expect(action).toBeInViewport();
  await expect(relation).toContainText("外部行动始终由你确认");
  await expect(page.getByRole("list", { name: "求职旅程" })).toContainText("推荐材料投递面试结果后续规划");
  expect(await action.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test("移动端无横向溢出，所有开始体验入口满足触控尺寸", async ({ page }, info) => {
  test.skip(info.project.name !== "Mobile Safari", "仅在移动项目检查触控尺寸");
  await page.goto("/");

  const heights = await page.getByRole("link", { name: "开始体验" }).evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThanOrEqual(2);
  expect(heights.every((height) => height >= 44)).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
});

test("键盘顺序先经过品牌、主导航行动和首页行动", async ({ page }, info) => {
  test.skip(info.project.name !== "Desktop Chrome", "iOS WebKit 仿真不支持硬件 Tab 焦点序列");
  await page.goto("/");
  const brand = page.getByRole("link", { name: "AI Job Search Copilot" });
  const headerAction = page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "开始体验" });
  const heroAction = page.getByRole("main").getByRole("link", { name: "开始体验" });
  await page.keyboard.press("Tab");
  await expect(brand).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(headerAction).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(heroAction).toBeFocused();
});

test("登录入口保留真实本地登录边界", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "开始体验" }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fhome$/u);
  await expect(page.getByText("本地开发登录")).toBeVisible();
  await expect(page.getByRole("button", { name: "使用本地体验账户登录" })).toBeVisible();
  await expect(page.getByRole("region", { name: "登录尚未开放" })).toBeVisible();
});

test("首页通过自动可访问性检查并尊重减少动态效果", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByLabel("机会、事实与决定的示例关系")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
