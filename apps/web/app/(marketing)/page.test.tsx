import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("renders the opportunity, confirmed fact, and decision relationship before the login boundary", () => {
  render(<MarketingPage />);

  expect(screen.getByRole("heading", { level: 1, name: "从值得投的机会，走向准备充分的面试。" })).toBeInTheDocument();
  expect(screen.getByText("已确认事实")).toBeInTheDocument();
  expect(screen.getByText("有依据，再决定")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "求职旅程" })).toHaveTextContent("推荐材料投递面试结果后续规划");
  expect(screen.getByRole("link", { name: "开始体验" })).toHaveAttribute("href", "/login?returnTo=%2Fhome");
});
