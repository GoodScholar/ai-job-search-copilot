import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("renders the approved promise and login action", () => {
  render(<MarketingPage />);

  expect(
    screen.getByRole("heading", { level: 1, name: "今天，只处理最值得投的 3 件事" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "微信登录体验" })).toHaveAttribute(
    "href",
    "/login?returnTo=%2F",
  );
});
