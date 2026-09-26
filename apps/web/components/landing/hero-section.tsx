import Link from "next/link";
import { BriefingStack } from "@/components/landing/briefing-stack";
import { buttonVariants } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="hero-section container" aria-labelledby="hero-title">
      <div className="hero-intro">
        <p className="hero-eyebrow">面向中高级技术岗位的求职协作</p>
        <h1 id="hero-title">每天先看值得你判断的机会</h1>
        <p className="hero-summary">把岗位证据、个人画像和下一步行动放在同一处，让决定更清晰。</p>
        <Link
          className={`${buttonVariants({ variant: "default", size: "lg" })} marketing-cta`}
          href="/login?returnTo=%2Fhome"
        >
          微信登录体验
        </Link>
      </div>

      <BriefingStack />

      <aside aria-label="Copilot 示例运行状态" className="copilot-status">
        <p className="copilot-annotation">由你确认后才继续</p>
        <p className="copilot-status-title">今日工作状态</p>
        <dl>
          <div>
            <dt>正在检查 12 家目标公司（示例）</dt>
            <dd>12</dd>
          </div>
          <div>
            <dt>8 家已完成（示例）</dt>
            <dd>8</dd>
          </div>
          <div>
            <dt>外部行动 0（示例）</dt>
            <dd>0</dd>
          </div>
        </dl>
      </aside>
    </section>
  );
}
