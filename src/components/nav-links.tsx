"use client";

import clsx from "clsx";
import { FilePlus2, LayoutDashboard, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/workflows/new", label: "New workflow", Icon: FilePlus2 },
  { href: "/settings", label: "Integrations", Icon: Settings },
];

export function NavLinks({ orientation }: { orientation: "vertical" | "horizontal" }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={clsx("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-row overflow-x-auto")}>
      {LINKS.map(({ href, label, Icon }) => {
        const active = href === "/dashboard" ? pathname === href || (pathname.startsWith("/workflows/") && pathname !== "/workflows/new") : pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex items-center gap-2.5 whitespace-nowrap rounded-md py-2 text-sm font-medium transition-colors",
              orientation === "vertical" ? "px-3" : "px-2.5 text-[13px]",
              active ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon aria-hidden className={clsx("size-4", orientation === "horizontal" && "hidden min-[440px]:block")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
