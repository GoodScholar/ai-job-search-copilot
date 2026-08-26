import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section className="final-cta container" aria-labelledby="final-cta-title">
      <p className="section-kicker">从今天的清单开始</p>
      <h2 id="final-cta-title">把判断留给自己，把准备交给 Copilot</h2>
      <Link className={buttonVariants({ variant: "default", size: "lg" })} href="/login?returnTo=%2F">
        微信登录体验
      </Link>
    </section>
  );
}
