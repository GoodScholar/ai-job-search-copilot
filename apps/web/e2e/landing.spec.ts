import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("职业透镜首页展示机会、事实、决定和完整旅程", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "从值得投的机会，走向准备充分的面试。" })).toBeVisible();
  await expect(page.getByLabel("机会、事实与决定的示例关系")).toContainText("已确认事实");
  await expect(page.getByLabel("机会、事实与决定的示例关系")).toContainText("有依据，再决定");
  await expect(page.getByRole("list", { name: "求职旅程" })).toContainText("推荐材料投递面试结果后续规划");
  await expect(page.getByRole("link", { name: "开始体验" }).first()).toHaveAttribute("href", "/login?returnTo=%2Fhome");
});

test("手机首页保持可触达主行动且无横向溢出", async ({ page }, info) => {
  test.skip(info.project.name !== "Mobile Safari", "仅在移动项目验收移动组织");
  await page.goto("/");
  const action = page.getByRole("link", { name: "开始体验" }).first();
  await expect(action).toBeVisible();
  expect(await action.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  await expect(new AxeBuilder({ page }).analyze()).resolves.toMatchObject({ violations: [] });
});
