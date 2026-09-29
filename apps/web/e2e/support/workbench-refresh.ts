import { expect, type Page, type Request } from "@playwright/test";

/** 在独立导航前等当前首页刷新结束，避免中断 RSC 后触发旧 URL 的整页回退。 */
export function trackWorkbenchRefresh(page: Page): () => Promise<void> {
  const pending = new Set<Request>();
  const failed = new Set<Request>();
  page.on("request", (request) => {
    const headers = request.headers();
    if (new URL(request.url()).pathname === "/home" && headers.rsc === "1" && headers["next-router-prefetch"] !== "1") pending.add(request);
  });
  page.on("requestfinished", (request) => { pending.delete(request); });
  page.on("requestfailed", (request) => {
    if (pending.delete(request)) failed.add(request);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname === "/home") failed.clear();
  });
  return async () => {
    // requestfailed 之后客户端仍可能回退到 /home；必须等整页回退提交。
    await expect.poll(() => pending.size + failed.size, { message: "首页刷新及失败回退应在独立导航前结束" }).toBe(0);
    await expect(page.locator("#workbench-home-title")).toBeVisible();
    await expect(page.getByText("网络已恢复，正在等待最新数据。", { exact: true })).toHaveCount(0);
  };
}
