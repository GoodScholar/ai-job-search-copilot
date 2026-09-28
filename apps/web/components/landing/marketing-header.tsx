import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function MarketingHeader() {
  return (
    <header className="marketing-header">
      <div className="container marketing-header-inner">
        <Link className="marketing-brand" href="/">AI Job Search Copilot</Link>
        <nav aria-label="主导航" className="marketing-nav">
          <Link
            className={`${buttonVariants({ variant: "default", size: "lg" })} marketing-cta`}
            href="/login?returnTo=%2Fhome"
          >
            开始体验
          </Link>
        </nav>
      </div>
    </header>
  );
}
