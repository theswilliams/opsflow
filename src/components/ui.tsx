import clsx from "clsx";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Cog,
  FileSearch,
  Hourglass,
  Inbox,
  Loader2,
  PlayCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";

const STATUS: Record<string, { label: string; cls: string; Icon: typeof Inbox }> = {
  RECEIVED: { label: "Received", cls: "border-slate-300 bg-slate-100 text-slate-700", Icon: Inbox },
  PROCESSING: { label: "Processing", cls: "border-sky-200 bg-sky-50 text-sky-800", Icon: Loader2 },
  EXTRACTED: { label: "Extracted", cls: "border-sky-200 bg-sky-50 text-sky-800", Icon: FileSearch },
  VALIDATING: { label: "Validating", cls: "border-sky-200 bg-sky-50 text-sky-800", Icon: ShieldCheck },
  REVIEW_REQUIRED: { label: "Review required", cls: "border-amber-300 bg-amber-50 text-amber-900", Icon: Hourglass },
  APPROVED: { label: "Approved", cls: "border-emerald-200 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
  EXECUTING: { label: "Executing", cls: "border-sky-200 bg-sky-50 text-sky-800", Icon: PlayCircle },
  COMPLETED: { label: "Completed", cls: "border-emerald-300 bg-emerald-50 text-emerald-900", Icon: CheckCircle2 },
  FAILED: { label: "Failed", cls: "border-red-300 bg-red-50 text-red-800", Icon: XCircle },
  REJECTED: { label: "Rejected", cls: "border-slate-300 bg-slate-100 text-slate-700", Icon: Ban },
};

export const STATUS_OPTIONS = Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }));

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "border-slate-300 bg-slate-100 text-slate-700", Icon: CircleDashed };
  return (
    <span className={clsx("pill", s.cls)}>
      <s.Icon aria-hidden className="size-3.5" />
      {s.label}
    </span>
  );
}

const CONF: Record<string, { label: string; cls: string; warn: boolean }> = {
  HIGH: { label: "High", cls: "border-emerald-200 bg-emerald-50 text-emerald-800", warn: false },
  MEDIUM: { label: "Medium", cls: "border-amber-300 bg-amber-50 text-amber-900", warn: true },
  LOW: { label: "Low", cls: "border-red-300 bg-red-50 text-red-800", warn: true },
  UNKNOWN: { label: "Unknown", cls: "border-slate-300 bg-slate-100 text-slate-600", warn: false },
};

export function ConfidenceBadge({ level }: { level: string }) {
  const c = CONF[level.toUpperCase()] ?? CONF.UNKNOWN!;
  return (
    <span className={clsx("pill", c.cls)} title="AI confidence estimate (qualitative, not a probability)">
      {c.warn ? <AlertTriangle aria-hidden className="size-3" /> : level.toUpperCase() === "UNKNOWN" ? <CircleHelp aria-hidden className="size-3" /> : <CheckCircle2 aria-hidden className="size-3" />}
      <span className="sr-only">AI confidence: </span>
      {c.label}
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 text-slate-400">{icon ?? <Cog aria-hidden className="size-8" />}</div>
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Alert({ tone, title, children }: { tone: "error" | "warning" | "info" | "success"; title?: string; children?: ReactNode }) {
  const tones = {
    error: "border-red-300 bg-red-50 text-red-900",
    warning: "border-amber-300 bg-amber-50 text-amber-950",
    info: "border-sky-200 bg-sky-50 text-sky-950",
    success: "border-emerald-300 bg-emerald-50 text-emerald-950",
  };
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? CircleHelp : tone === "warning" ? AlertTriangle : XCircle;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={clsx("flex gap-3 rounded-md border px-4 py-3 text-sm", tones[tone])}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
    </div>
  );
}
