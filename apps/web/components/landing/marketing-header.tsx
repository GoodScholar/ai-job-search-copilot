import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function MarketingHeader() {
  return (
    <header>
      <div className="container flex min-h-16 items-center justify-between gap-6">
        <Link href="/">AI Job Search Copilot</Link>
        <nav aria-label="主导航" className="flex items-center gap-5">
          <a href="#how-it-works">工作方式</a>
          <a href="#evidence-and-control">证据与控制</a>
          <Link
            className={buttonVariants({ variant: "default", size: "lg" })}
            href="/login?returnTo=%2F"
          >
            微信登录体验
          </Link>
        </nav>
      </div>
    </header>
  );
}
