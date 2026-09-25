import { redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Brand } from "@/components/brand";
import { getCurrentUser } from "@/lib/auth/current-user";

const STEPS = ["Paste, upload or POST a messy request", "AI extracts structured fields — with what is missing or ambiguous", "Deterministic validation and business rules", "A person reviews, edits and approves", "Automated action, with a complete audit trail"];

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="hidden flex-col justify-between bg-ink px-12 py-10 text-slate-200 lg:flex">
        <Brand dark />
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight text-white">Turn messy business requests into structured, actionable workflows.</h2>
          <ul className="mt-8 space-y-3 text-[15px]">
            {STEPS.map((s) => (
              <li key={s} className="flex gap-3">
                <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-sky-400" />
                {s}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-400">Nothing executes without a recorded human approval.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
