"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WorkbenchIcon } from "./workbench-icon";

const navigation: ReadonlyArray<{ href?: "/home" | "/profile" | "/recommendations"; icon: "home" | "recommendations" | "applications" | "profile"; label: string }> = [
  { href: "/home", icon: "home", label: "首页" },
  { href: "/recommendations", icon: "recommendations", label: "推荐" },
  { icon: "applications", label: "投递" },
  { href: "/profile", icon: "profile", label: "画像" },
];

const profileContextNavigation = [
  { href: "/profile", label: "职业资料" },
  { href: "/profile/targets", label: "目标与来源" },
  { href: "/profile/run-policy", label: "运行策略" },
  { href: "/profile/model-connection", label: "模型连接" },
] as const;

export function WorkbenchNavigation() {
  const pathname = usePathname();

  const inProfile = pathname.startsWith("/profile");

  return <>
    <nav aria-label="求职工作台导航" className="workbench-nav">
      {navigation.map(({ href, icon, label }) => href ? (
        <Link
          aria-current={pathname === href || (href === "/profile" && inProfile) ? "page" : undefined}
          className="workbench-nav-link workbench-touch-target"
          href={href}
          key={href}
        ><WorkbenchIcon name={icon} />{label}</Link>
      ) : <span aria-disabled="true" className="workbench-nav-pending" key={label}><WorkbenchIcon name={icon} />{label}</span>)}
    </nav>
    {inProfile ? <nav aria-label="画像上下文" className="profile-context-nav">
      {profileContextNavigation.map(({ href, label }) => <Link
        aria-current={pathname === href || (href === "/profile/targets" && pathname.startsWith("/profile/targets/")) ? "page" : undefined}
        className="profile-context-nav-link workbench-touch-target"
        href={href}
        key={href}
      >{label}</Link>)}
    </nav> : null}
  </>;
}
