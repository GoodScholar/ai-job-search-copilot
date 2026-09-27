import { CareerLensJourney } from "@/components/landing/career-lens-journey";
import { HeroSection } from "@/components/landing/hero-section";
import { MarketingFooter } from "@/components/landing/marketing-footer";

export default function MarketingPage() {
  return (
    <>
      <main>
        <HeroSection />
        <CareerLensJourney />
      </main>
      <MarketingFooter />
    </>
  );
}
