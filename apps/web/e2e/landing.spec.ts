import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const briefingTabs = [
  "AI 应用工程师（示例）",
  "确认 2 条候选事实（示例）",
  "审核 1 份定制简历（示例）",
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

  for (const label of briefingTabs) {
    await expect(page.getByRole("tab", { name: label })).toBeInViewport();
  }

  await expect(page.getByText("由你确认后才继续")).toBeInViewport();
});

test("390×844 首屏保留品牌和主 CTA，并先展示标题与行动简报", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Safari", "仅在移动端验收内容顺序");

  await page.goto("/");

  const heading = page.getByRole("heading", {
    level: 1,
    name: "今天，只处理最值得投的 3 件事",
  });
  const cta = page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first();
  const briefingStack = page.getByLabel("今日行动简报");
  const navigation = page.getByRole("navigation", { name: "主导航" });

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
  await expect(navigation.getByRole("link", { name: "工作方式" })).toBeHidden();
  await expect(navigation.getByRole("link", { name: "证据与控制" })).toBeHidden();
  await expect(navigation.getByRole("link", { name: "微信登录体验" })).toBeVisible();
});

test("移动端三处登录 CTA 均满足 44px 触控高度", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Mobile Safari", "仅在移动端检查触控尺寸");

  await page.goto("/");

  const heights = await page.getByRole("link", { name: "微信登录体验" }).evaluateAll((links) =>
    links.map((link) => link.getBoundingClientRect().height),
  );

  expect(heights).toHaveLength(3);
  expect(heights.every((height) => height >= 44)).toBe(true);
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

test("桌面端可直接点击露出的档案纸将其置前", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "仅在桌面检查错位纸张的鼠标操作");

  await page.goto("/");

  const facts = page.getByRole("tab", { name: briefingTabs[1] });
  await facts.click();

  await expect(facts).toHaveAttribute("aria-selected", "true");
});

test("桌面待处理纸可辨识并可直接点击第三张纸置前", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "仅在桌面检查待处理纸的可辨性与鼠标操作");

  await page.goto("/");

  const facts = page.getByRole("tab", { name: briefingTabs[1] });
  const resume = page.getByRole("tab", { name: briefingTabs[2] });

  await expect(facts).toContainText("确认 2 条候选事实");
  await expect(facts).toContainText("待你确认");
  await expect(resume).toContainText("审核 1 份定制简历");
  await expect(resume).toContainText("待你审核");

  await resume.click();

  await expect(resume).toHaveAttribute("aria-selected", "true");
});

test("键盘按顺序到达导航、CTA 与三张简报 tab，并可切换简报", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "iOS WebKit 仿真不支持硬件 Tab 焦点序列");

  await page.goto("/");

  const brand = page.getByRole("link", { name: "AI Job Search Copilot" });
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const workLink = navigation.getByRole("link", { name: "工作方式" });
  const evidenceLink = navigation.getByRole("link", { name: "证据与控制" });
  const headerCta = navigation.getByRole("link", { name: "微信登录体验" });
  const heroCta = page.getByRole("main").getByRole("link", { name: "微信登录体验" }).first();
  const [recommendation, facts, resume] = briefingTabs.map((name) =>
    page.getByRole("tab", { name }),
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
  await expect(recommendation).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowRight");
  await expect(facts).toBeFocused();
  await expect(facts).toHaveAttribute("aria-selected", "true");
  await expect(recommendation).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("ArrowRight");
  await expect(resume).toBeFocused();
  await expect(resume).toHaveAttribute("aria-selected", "true");
  await expect(facts).toHaveAttribute("aria-selected", "false");
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

test("减少动态效果时简报立即完成切换并显示活动内容", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const recommendation = page.getByRole("tab", { name: briefingTabs[0] });
  const resume = page.getByRole("tab", { name: briefingTabs[2] });

  await resume.focus();
  await page.keyboard.press("Enter");

  await expect(resume).toHaveAttribute("aria-selected", "true");
  await expect(recommendation).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel")).toContainText("Markdown 简历草稿");
});
