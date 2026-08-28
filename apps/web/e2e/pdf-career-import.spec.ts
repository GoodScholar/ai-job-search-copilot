import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const secret = "issue-2-e2e-dev-auth-shared-secret";

function createPdf(pages: readonly string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const pageNumbers: number[] = [];
  for (const text of pages) {
    const page = objects.length + 1; const content = page + 1; pageNumbers.push(page);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${content + 1} 0 R >> >> /Contents ${content} 0 R >>`);
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  }
  objects[1] = `<< /Type /Pages /Kids [${pageNumbers.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

async function signIn(page: Page, request: APIRequestContext, suffix: string) {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `pdf-import-${suffix}-${Date.now()}` } });
  expect(response.status()).toBe(201);
  await page.context().addCookies([{ name: "job_copilot_session", value: (await response.json() as { sessionToken: string }).sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/profile");
}

test("文本型 PDF 经完整导入链路显示页码证据，无文本层 PDF 诚实失败且不入队", async ({ page, request }, testInfo) => {
  await signIn(page, request, testInfo.project.name);
  const input = page.getByLabel("选择 Markdown、DOCX 或 PDF 职业资料");
  await input.setInputFiles({ name: "career.pdf", mimeType: "application/pdf", buffer: createPdf(["## Skills", "- TypeScript"]) });
  await page.getByLabel(/我已检查该文件/).check();
  await page.getByRole("button", { name: "上传并解析" }).click();
  await expect(page.getByRole("status")).toContainText(/等待解析|解析中|解析完成/);
  await expect(page.getByText("TypeScript", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();

  await input.setInputFiles({ name: "scanned.pdf", mimeType: "application/pdf", buffer: createPdf([]) });
  await expect(page.getByRole("status")).toHaveText("该 PDF 没有可读取的文本层，请上传文本型 PDF。");
  await expect(page.getByRole("button", { name: "上传并解析" })).toBeDisabled();
});
