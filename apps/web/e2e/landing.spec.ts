import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const briefingButtons = [
  "查看岗位推荐",
  "查看确认 2 条候选事实",
  "查看审核 1 份定制简历",
] as const;

test("1440×900 首屏同时展示核心行动信息", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "仅在桌面验收首屏布局");

  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "今天，只处理最值得投的 3 件事" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first(),
  ).toBeInViewport();

  for (const label of [
    "AI 应用工程师（示例）",
    "确认 2 条候选事实（示例）",
    "审核 1 份定制简历（示例）",
  ]) {
    await expect(page.getByRole("article", { name: label })).toBeInViewport();
  }

  await expect(page.getByText("由你确认后才继续")).toBeInViewport();
});

test("390×844 首屏先展示标题与 CTA，再展示行动简报", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Safari", "仅在移动端验收内容顺序");

  await page.goto("/");

  const heading = page.getByRole("heading", {
    level: 1,
    name: "今天，只处理最值得投的 3 件事",
  });
  const cta = page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first();
  const briefingStack = page.getByLabel("今日行动简报");

  await expect(heading).toBeInViewport();
  await expect(cta).toBeInViewport();
  await expect(briefingStack).toBeInViewport();

  const [headingBox, ctaBox, briefingBox] = await Promise.all([
    heading.boundingBox(),
    cta.boundingBox(),
    briefingStack.boundingBox(),
  ]);

  expect(headingBox).not.toBeNull();
  expect(ctaBox).not.toBeNull();
  expect(briefingBox).not.toBeNull();
  expect(headingBox!.y).toBeLessThan(ctaBox!.y);
  expect(ctaBox!.y).toBeLessThan(briefingBox!.y);
});

test("移动端页面没有横向滚动", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Safari", "仅在移动端检查横向溢出");

  await page.goto("/");

  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));

  expect(widths.scroll).toBe(widths.client);
});

test("首页通过自动可访问性检查", async ({ page }) => {
  await page.goto("/");

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});

test("键盘按顺序到达导航、CTA 与三张简报，并可切换简报", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "iOS WebKit 仿真不支持硬件 Tab 焦点序列");

  await page.goto("/");

  const brand = page.getByRole("link", { name: "AI Job Search Copilot" });
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const workLink = navigation.getByRole("link", { name: "工作方式" });
  const evidenceLink = navigation.getByRole("link", { name: "证据与控制" });
  const headerCta = navigation.getByRole("link", { name: "微信登录体验" });
  const heroCta = page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first();
  const [recommendation, facts, resume] = briefingButtons.map((name) =>
    page.getByRole("button", { name }),
  );

  await page.keyboard.press("Tab");
  await expect(brand).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(workLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(evidenceLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(headerCta).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(heroCta).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(recommendation).toBeFocused();
  await expect(recommendation).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Tab");
  await expect(facts).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(facts).toHaveAttribute("aria-pressed", "true");
  await expect(recommendation).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Tab");
  await expect(resume).toBeFocused();
  await page.keyboard.press("Space");
  await expect(resume).toHaveAttribute("aria-pressed", "true");
  await expect(facts).toHaveAttribute("aria-pressed", "false");
});

test("CTA 进入登录边界并提供本地开发说明", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first().click();

  await expect(page).toHaveURL(/\/login\?returnTo=%2F$/);
  await expect(page.getByText("本地开发登录")).toBeVisible();
  await expect(
    page.getByText("本实施批次只建立登录边界，尚未创建用户会话"),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "登录尚未开放" })).toBeVisible();
});

test("减少动态效果时简报立即完成切换", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const recommendation = page.getByRole("button", { name: "查看岗位推荐" });
  const resume = page.getByRole("button", { name: "查看审核 1 份定制简历" });

  await resume.click();

  expect(await resume.getAttribute("aria-pressed")).toBe("true");
  expect(await recommendation.getAttribute("aria-pressed")).toBe("false");
});
