import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function MarketingHeader() {
  return (
    <header className="marketing-header">
      <div className="container marketing-header-inner">
        <Link className="marketing-brand" href="/">AI Job Search Copilot</Link>
        <nav aria-label="主导航" className="marketing-nav">
          <a className="marketing-nav-anchor" href="#how-it-works">工作方式</a>
          <a className="marketing-nav-anchor" href="#evidence-and-control">证据与控制</a>
          <Link
            className={`${buttonVariants({ variant: "default", size: "lg" })} marketing-cta`}
            href="/login?returnTo=%2F"
          >
            微信登录体验
          </Link>
        </nav>
      </div>
    </header>
  );
}
