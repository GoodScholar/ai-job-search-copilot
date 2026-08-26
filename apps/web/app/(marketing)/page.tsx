import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function MarketingPage() {
  return (
    <main className="container flex flex-col gap-6 py-16">
      <h1>今天，只处理最值得投的 3 件事</h1>
      <Link
        className={buttonVariants({ variant: "default", size: "lg" })}
        href="/login?returnTo=%2F"
      >
        微信登录体验
      </Link>
    </main>
  );
}
