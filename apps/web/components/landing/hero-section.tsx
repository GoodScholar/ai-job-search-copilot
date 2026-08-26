import Link from "next/link";
import { BriefingStack } from "@/components/landing/briefing-stack";
import { buttonVariants } from "@/components/ui/button";

export function HeroSection() {
  return (
    <section className="hero-section container" aria-labelledby="hero-title">
      <div className="hero-intro">
        <p className="hero-eyebrow">晨间求职内参 · 今日行动优先</p>
        <h1 id="hero-title">今天，只处理最值得投的 3 件事</h1>
        <p className="hero-summary">推荐、确认和材料准备，按价值排好顺序。</p>
        <Link
          className={buttonVariants({ variant: "default", size: "lg" })}
          href="/login?returnTo=%2F"
        >
          微信登录体验
        </Link>
      </div>

      <BriefingStack />

      <aside aria-label="Copilot 示例运行状态" className="copilot-status">
        <p className="copilot-annotation">由你确认后才继续</p>
        <p className="copilot-status-title">Copilot Agent</p>
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
