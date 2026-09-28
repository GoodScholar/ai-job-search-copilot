import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("keeps the career lens journey free from invented user records", () => {
  render(<MarketingPage />);

  expect(screen.getByText("示例关系，不代表你的岗位或画像")).toBeInTheDocument();
  expect(screen.getByText("外部行动始终由你确认")).toBeInTheDocument();
  expect(screen.queryByText(/成功率\s*\d+%|无需确认即可自动投递|全自动投递/)).not.toBeInTheDocument();
});
