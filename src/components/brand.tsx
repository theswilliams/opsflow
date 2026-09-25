import { Workflow } from "lucide-react";

export function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-md bg-brand text-white">
        <Workflow aria-hidden className="size-4" />
      </span>
      <span className={dark ? "text-white" : "text-slate-900"}>OpsFlow</span>
    </span>
  );
}
