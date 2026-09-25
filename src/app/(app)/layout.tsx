import { FlaskConical, LogOut } from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { Brand } from "@/components/brand";
import { NavLinks } from "@/components/nav-links";
import { isDemoMode } from "@/lib/ai";
import { requireUser } from "@/lib/auth/current-user";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const demo = isDemoMode();

  const signOut = (
    <form action={logoutAction}>
      <button type="submit" className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/5 hover:text-white">
        <LogOut aria-hidden className="size-4" />
        Sign out
      </button>
    </form>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col justify-between bg-ink px-3 py-5 md:flex">
        <div>
          <div className="px-3 pb-6">
            <Brand dark />
          </div>
          <NavLinks orientation="vertical" />
        </div>
        <div>
          <div className="mb-2 border-t border-white/10 px-3 pt-4">
            <p className="truncate text-sm font-medium text-white">{user.name}</p>
            <p className="truncate text-xs text-slate-400">{user.email}</p>
          </div>
          {signOut}
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="bg-ink px-3 py-3 md:hidden">
        <div className="mb-2 flex items-center justify-between px-1">
          <Brand dark />
          <form action={logoutAction}>
            <button type="submit" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-300 hover:text-white">
              <LogOut aria-hidden className="size-3.5" /> Sign out
            </button>
          </form>
        </div>
        <NavLinks orientation="horizontal" />
      </header>

      <div className="min-w-0">
        {demo && (
          <div role="status" className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950 sm:px-8">
            <FlaskConical aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <p>
              <strong>Demo mode.</strong> AI extraction is performed by a deterministic rule-based mock provider (not a live model), and approved actions are simulated — nothing is sent to anyone.
            </p>
          </div>
        )}
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
