import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { CareerLensJourney } from "./career-lens-journey";

export function HeroSection() {
  return (
    <section aria-labelledby="hero-title" className="career-lens-hero">
      <div className="container career-lens-board">
        <div className="career-lens-copy">
          <p className="career-lens-kicker">AI Job Search Copilot</p>
          <h1 id="hero-title">从值得投的机会，走向准备充分的面试。</h1>
          <p>把真实岗位、已确认职业事实和你的决定放在同一条可追溯的路径上。</p>
          <Link className={`${buttonVariants({ variant: "default", size: "lg" })} career-lens-cta`} href="/login?returnTo=%2Fhome">开始体验</Link>
        </div>
        <div aria-label="机会、事实与决定的示例关系" className="career-lens-relation">
          <article className="career-lens-object career-lens-opportunity"><p>岗位机会</p><strong>值得进一步判断的机会</strong><span>示例，不是你的岗位</span></article>
          <div aria-hidden="true" className="career-lens-line" />
          <article className="career-lens-object career-lens-fact"><p>已确认事实</p><strong>可追溯的职业资料</strong><span>只使用真实证据</span></article>
          <article className="career-lens-decision"><span aria-hidden="true">●</span><strong>有依据，再决定</strong><p>外部行动始终由你确认</p></article>
          <p className="career-lens-disclaimer">示例关系，不代表你的岗位或画像</p>
        </div>
        <CareerLensJourney />
      </div>
    </section>
  );
}
