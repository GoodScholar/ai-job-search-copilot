"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation: ReadonlyArray<{ href?: "/home" | "/profile"; label: string }> = [
  { href: "/home", label: "首页" },
  { label: "推荐" },
  { label: "投递" },
  { href: "/profile", label: "画像" },
];

export function WorkbenchNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="求职工作台导航" className="workbench-nav">
      {navigation.map(({ href, label }) => href ? (
        <Link
          aria-current={pathname === href || (href === "/profile" && pathname.startsWith("/profile/")) ? "page" : undefined}
          className="workbench-nav-link workbench-touch-target"
          href={href}
          key={href}
        >
          {label}
        </Link>
      ) : <span aria-disabled="true" className="workbench-nav-pending" key={label}>{label}</span>)}
    </nav>
  );
}
