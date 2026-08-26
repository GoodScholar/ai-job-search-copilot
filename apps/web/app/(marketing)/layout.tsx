import { MarketingHeader } from "@/components/landing/marketing-header";

export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <MarketingHeader />
      {children}
    </>
  );
}
