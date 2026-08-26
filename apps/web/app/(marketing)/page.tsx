import { ApprovalBoundarySection } from "@/components/landing/approval-boundary-section";
import { BackgroundWorkSection } from "@/components/landing/background-work-section";
import { EvidenceChainSection } from "@/components/landing/evidence-chain-section";
import { FinalCta } from "@/components/landing/final-cta";
import { HeroSection } from "@/components/landing/hero-section";
import { MarketingFooter } from "@/components/landing/marketing-footer";
import { ResumeFormatSection } from "@/components/landing/resume-format-section";

export default function MarketingPage() {
  return (
    <>
      <main>
        <HeroSection />
        <BackgroundWorkSection />
        <EvidenceChainSection />
        <ApprovalBoundarySection />
        <ResumeFormatSection />
        <FinalCta />
      </main>
      <MarketingFooter />
    </>
  );
}
