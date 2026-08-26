import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("keeps the evidence and approval narrative before the final login action", () => {
  render(<MarketingPage />);

  const headings = screen.getAllByRole("heading").map((node) => node.textContent);
  const expectedHeadings = [
    "Copilot 在后台工作，你只处理关键决定",
    "值得投，不只是一个分数",
    "任何外部行动，都先经过你的确认",
    "一份画像，多种简历格式",
  ];

  expect(headings).toEqual(expect.arrayContaining(expectedHeadings));
  expect(headings.indexOf(expectedHeadings[0])).toBeLessThan(headings.indexOf(expectedHeadings[1]));
  expect(headings.indexOf(expectedHeadings[1])).toBeLessThan(headings.indexOf(expectedHeadings[2]));
  expect(headings.indexOf(expectedHeadings[2])).toBeLessThan(headings.indexOf(expectedHeadings[3]));

  expect(screen.getByText("检查目标公司")).toBeInTheDocument();
  expect(screen.getByText("资格门槛")).toBeInTheDocument();
  expect(screen.getByText("证据匹配")).toBeInTheDocument();
  expect(screen.getByText("生成今日清单")).toBeInTheDocument();
  expect(screen.getByText("主导 React 应用架构拆分（示例）")).toBeInTheDocument();
  expect(screen.getByText("来源可追溯")).toBeInTheDocument();
  expect(screen.getByText("缺口不隐藏")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "值得投，不只是一个分数" }).closest("section"),
  ).toHaveAttribute("id", "evidence-and-control");
  expect(
    screen.getByRole("heading", { name: "Copilot 在后台工作，你只处理关键决定" }).closest("section"),
  ).toHaveAttribute("id", "how-it-works");
  expect(screen.getByText("提交申请")).toBeInTheDocument();
  expect(screen.getByText("发送邮件")).toBeInTheDocument();
  expect(screen.getByText("联系招聘者")).toBeInTheDocument();
  expect(screen.getByText("本地 Beta 不自动执行外部行动")).toBeInTheDocument();
  expect(screen.getByText(/Markdown 是一级导入\/导出格式/)).toBeInTheDocument();
  expect(screen.getByText("DOCX")).toBeInTheDocument();
  expect(screen.getByText("PDF")).toBeInTheDocument();
  expect(screen.getByText("8 家已完成（示例）")).toBeInTheDocument();
  expect(screen.getByText("外部行动 0（示例）")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "微信登录体验" })).toHaveLength(2);
  expect(document.querySelectorAll("section:not([aria-labelledby])")).toHaveLength(0);
  expect(screen.queryByText(/已有\s*\d+.*用户|成功率\s*\d+%|无需确认即可自动投递|全自动投递/)).not.toBeInTheDocument();
});
