import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { WorkflowDetail } from "@/lib/workflow/queries";
import type { Extraction } from "@/lib/ai/schema";
import type { ValidationIssue } from "@/lib/validation/delivery";
import { FIELD_LABEL, formatFullDateTime, formatTime } from "@/lib/format";
import { RetryButton } from "./retry-button";
import { EmptyState } from "./ui";

export function AiAnalysis({ data }: { data: NonNullable<WorkflowDetail["extracted"]> }) {
  const missing = data.missingInformation as string[];
  const ambiguities = data.ambiguities as Extraction["ambiguities"];
  const isMock = data.provider === "mock";
  return (
    <section aria-labelledby="ai-h" className="card">
      <div className="card-header">
        <h2 id="ai-h" className="card-title">AI analysis</h2>
        <span className={clsx("pill", isMock ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-300 bg-slate-100 text-slate-700")}>
          {isMock ? "Mock provider (demo)" : `Claude · ${data.model}`}
        </span>
      </div>
      <div className="card-body space-y-4 text-sm">
        {data.reason && (
          <div>
            <h3 className="text-[13px] font-semibold text-slate-700">Summary</h3>
            <p className="mt-0.5 text-slate-900">{data.reason}</p>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-[13px] font-semibold text-slate-700">Missing information</h3>
            {missing.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-900">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None reported.</p>
            )}
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-slate-700">Ambiguities</h3>
            {ambiguities.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-900">
                {ambiguities.map((a) => (
                  <li key={a.field + a.note}>
                    <span className="font-medium">{FIELD_LABEL[a.field] ?? a.field}:</span> {a.note}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">None reported (or resolved by a reviewer).</p>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-slate-600 sm:grid-cols-4">
          <div><dt className="font-medium">AI recommends</dt><dd>{data.recommendedAction.replaceAll("_", " ")}</dd></div>
          <div><dt className="font-medium">Flagged for review</dt><dd>{data.requiresHumanReview ? "Yes" : "No"}</dd></div>
          <div><dt className="font-medium">Attempts</dt><dd>{data.attempts}</dd></div>
          <div><dt className="font-medium">Provider</dt><dd>{data.provider}</dd></div>
        </dl>
        <p className="flex gap-2 text-xs text-slate-500">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Confidence levels are the model&apos;s qualitative estimate for each field. They are not calibrated probabilities and never replace validation or review.
        </p>
      </div>
    </section>
  );
}

export function ValidationCard({ result }: { result: WorkflowDetail["validations"][number] | undefined }) {
  const issues = (result?.issues ?? []) as unknown as ValidationIssue[];
  return (
    <section aria-labelledby="val-h" className="card">
      <div className="card-header">
        <h2 id="val-h" className="card-title">Validation</h2>
        {result && (
          <span className="text-xs text-slate-600">
            {result.errorCount} error{result.errorCount === 1 ? "" : "s"} · {result.warningCount} warning{result.warningCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {!result ? (
        <EmptyState title="Not validated yet">Validation runs after extraction.</EmptyState>
      ) : issues.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-800 sm:px-5">
          <CheckCircle2 aria-hidden className="size-4" /> All deterministic checks passed.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {issues.map((i) => (
            <li key={i.code + i.message} className="flex items-start gap-3 px-4 py-3 text-sm sm:px-5">
              {i.severity === "error" ? <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />}
              <div className="min-w-0">
                <p className="text-slate-900"><span className="sr-only">{i.severity}: </span>{i.message}</p>
                <p className="mt-0.5 text-xs text-slate-500">{FIELD_LABEL[i.field] ?? i.field} · <span className="font-mono">{i.code}</span></p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourceCard({ input }: { input: WorkflowDetail["input"] }) {
  if (!input) return null;
  return (
    <section aria-labelledby="src-h" className="card">
      <details>
        <summary className="card-header cursor-pointer list-none">
          <h2 id="src-h" className="card-title">Original request</h2>
          <span className="text-xs text-slate-500">
            {input.kind === "document" ? `${input.fileName ?? "document"} · ` : ""}{input.sizeBytes.toLocaleString("en-CA")} bytes · show
          </span>
        </summary>
        {/* Rendered as inert text: React escapes it, and it never becomes HTML. */}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-slate-50 px-4 py-3 font-mono text-xs text-slate-800 sm:px-5">{input.content.slice(0, 5000)}</pre>
      </details>
    </section>
  );
}

export function ReviewHistory({ reviews }: { reviews: WorkflowDetail["reviews"] }) {
  return (
    <section aria-labelledby="rev-h" className="card">
      <div className="card-header"><h2 id="rev-h" className="card-title">Review</h2></div>
      {reviews.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-600 sm:px-5">No decision yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {reviews.map((r) => {
            const changes = r.changes as { field: string; from: unknown; to: unknown }[];
            return (
              <li key={r.id} className="px-4 py-3 text-sm sm:px-5">
                <p className="font-medium text-slate-900">{r.decision === "APPROVED" ? "Approved" : "Rejected"} by you</p>
                <p className="text-xs text-slate-500">{formatFullDateTime(r.createdAt)}</p>
                {r.comment && <p className="mt-1 text-slate-700">“{r.comment}”</p>}
                {changes.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-semibold text-slate-600">Changed from the AI output</p>
                    <ul className="mt-1 space-y-1 text-xs text-slate-700">
                      {changes.map((c) => (
                        <li key={c.field}><span className="font-medium">{FIELD_LABEL[c.field] ?? c.field}:</span> <span className="text-slate-500 line-through">{fmt(c.from)}</span> → {fmt(c.to)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (Array.isArray(v)) return v.map((i) => (typeof i === "object" && i ? `${(i as { quantity?: unknown }).quantity ?? "?"} ${(i as { unit?: unknown }).unit ?? ""} ${(i as { description?: unknown }).description ?? ""}`.replace(/\s+/g, " ").trim() : String(i))).join("; ") || "none";
  return String(v);
}

export function ActionsCard({ workflow }: { workflow: WorkflowDetail }) {
  return (
    <section aria-labelledby="act-h" className="card">
      <div className="card-header"><h2 id="act-h" className="card-title">Automated action</h2></div>
      {workflow.actions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-600 sm:px-5">
          {workflow.status === "REJECTED" ? "Rejected — no action was taken." : "No action has run. An action only runs after a person approves this workflow."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {workflow.actions.map((a) => {
            const out = a.output as { subject?: string; body?: string; delivery?: string } | null;
            return (
              <li key={a.id} className="px-4 py-3 text-sm sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-900">Customer confirmation</p>
                  <span className={clsx("pill", a.status === "SUCCEEDED" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800")}>
                    {a.status === "SUCCEEDED" ? "Succeeded" : "Failed"}
                  </span>
                </div>
                <p className="text-xs text-slate-500">{formatFullDateTime(a.createdAt)} · mode: {a.mode}</p>
                {a.error && <p className="mt-1 text-red-700">{a.error}</p>}
                {out?.body && (
                  <>
                    <p className="mt-2 text-xs font-semibold text-slate-600">{out.subject}</p>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-slate-50 p-3 font-mono text-xs text-slate-800">{out.body}</pre>
                    {out.delivery && <p className="mt-1 text-xs font-medium text-amber-800">{out.delivery}</p>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {workflow.status === "FAILED" && (
        <div className="border-t border-line px-4 py-3 sm:px-5">
          {workflow.failureReason && !workflow.actions.some((x) => x.error) && <p className="mb-2 text-sm text-red-800">{workflow.failureReason}</p>}
          <RetryButton workflowId={workflow.id} label={workflow.reviews.some((r) => r.decision === "APPROVED") ? "Retry action" : "Retry processing"} />
        </div>
      )}
    </section>
  );
}

const ACTOR: Record<string, string> = { USER: "You", SYSTEM: "System", WEBHOOK: "Webhook" };

export function Timeline({ events }: { events: WorkflowDetail["auditEvents"] }) {
  return (
    <section aria-labelledby="tl-h" className="card">
      <div className="card-header"><h2 id="tl-h" className="card-title">Timeline</h2><span className="text-xs text-slate-500">{events.length} events</span></div>
      <ol className="px-4 py-3 sm:px-5">
        {events.map((e, i) => {
          const meta = (e.metadata ?? {}) as Record<string, unknown>;
          const changes = Array.isArray(meta.changes) ? (meta.changes as { field: string; from: unknown; to: unknown }[]) : [];
          return (
            <li key={e.id} className="relative flex gap-3 pb-4 last:pb-1">
              {i < events.length - 1 && <span aria-hidden className="absolute left-[5px] top-3 h-full w-px bg-line" />}
              <span aria-hidden className={clsx("relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 bg-white", e.eventType.includes("FAILED") || e.eventType === "WEBHOOK_REJECTED" ? "border-red-500" : e.eventType === "REVIEW_REQUIRED" ? "border-amber-500" : e.eventType.includes("COMPLETED") || e.eventType === "WORKFLOW_APPROVED" ? "border-emerald-600" : "border-slate-400")} />
              <div className="min-w-0 text-sm">
                <p className="text-slate-900">{e.message}</p>
                <p className="text-xs text-slate-500">
                  <time dateTime={e.createdAt.toISOString()} title={formatFullDateTime(e.createdAt)} className="font-mono">{formatTime(e.createdAt)}</time> · {ACTOR[e.actorType] ?? e.actorType}
                  {typeof meta.durationMs === "number" && ` · ${meta.durationMs} ms`}
                </p>
                {changes.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                    {changes.map((c) => (
                      <li key={c.field}>{FIELD_LABEL[c.field] ?? c.field}: {fmt(c.from)} → {fmt(c.to)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
