"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/home", label: "首页" },
  { href: "/profile", label: "画像" },
] as const;

export function WorkbenchNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="求职工作台导航" className="workbench-nav">
      {navigation.map(({ href, label }) => (
        <Link
          aria-current={pathname === href ? "page" : undefined}
          className="workbench-nav-link workbench-touch-target"
          href={href}
          key={href}
        >
          {label}
        </Link>
      ))}
      <span aria-disabled="true" className="workbench-nav-pending">推荐</span>
      <span aria-disabled="true" className="workbench-nav-pending">投递</span>
    </nav>
  );
}
