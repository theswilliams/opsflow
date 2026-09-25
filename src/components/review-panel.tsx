"use client";

import clsx from "clsx";
import { AlertTriangle, Check, Pencil, Plus, Trash2, X, XCircle } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { approveAction, editFieldsAction, rejectAction } from "@/app/actions/workflows";
import type { ActionState } from "@/app/actions/types";
import type { ExtractedFields, FieldAssessment, FieldName } from "@/lib/ai/schema";
import { formatClock, formatLongDate } from "@/lib/dates";
import type { ValidationIssue } from "@/lib/validation/delivery";
import { FieldError, SubmitButton } from "./form";
import { Alert, ConfidenceBadge } from "./ui";

export type ReviewAssessments = Record<FieldName, FieldAssessment & { edited?: boolean }>;

interface Props {
  workflowId: string;
  /** True only while the workflow is awaiting review. */
  canReview: boolean;
  fields: ExtractedFields;
  assessments: ReviewAssessments;
  issues: ValidationIssue[];
  reasons: string[];
}

const STATUS_LABEL: Record<string, string> = { known: "Stated", inferred: "Inferred", ambiguous: "Ambiguous", missing: "Missing" };
const STATUS_CLS: Record<string, string> = {
  known: "text-slate-600",
  inferred: "text-sky-800",
  ambiguous: "font-semibold text-amber-800",
  missing: "font-semibold text-red-700",
};

interface Row {
  key: string;
  label: string;
  value: React.ReactNode;
  assess: FieldAssessment & { edited?: boolean };
  issueFields: string[];
}

function buildRows(f: ExtractedFields, a: ReviewAssessments): Row[] {
  const time =
    f.requested_time_start && f.requested_time_end
      ? `${formatClock(f.requested_time_start)} – ${formatClock(f.requested_time_end)}`
      : f.requested_time_start
        ? `From ${formatClock(f.requested_time_start)}`
        : f.requested_time_window && f.requested_time_window !== "unspecified" && f.requested_time_window !== "specific"
          ? `${f.requested_time_window[0]!.toUpperCase()}${f.requested_time_window.slice(1)}`
          : null;
  return [
    { key: "customer", label: "Customer", value: f.customer, assess: a.customer, issueFields: ["customer"] },
    { key: "address", label: "Delivery address", value: f.address, assess: a.address, issueFields: ["address"] },
    { key: "requested_date", label: "Requested date", value: f.requested_date ? formatLongDate(f.requested_date) : null, assess: a.requested_date, issueFields: ["requested_date", "duplicate"] },
    { key: "time", label: "Requested time", value: time, assess: a.requested_time_window, issueFields: ["requested_time_window", "requested_time_start", "requested_time_end"] },
    {
      key: "items",
      label: "Items",
      value: f.items.length ? (
        <ul className="space-y-0.5">
          {f.items.map((i, n) => (
            <li key={n}>
              {i.quantity ?? "?"} × {i.unit ?? "units"} — {i.description}
            </li>
          ))}
        </ul>
      ) : null,
      assess: a.items,
      issueFields: ["items"],
    },
    { key: "contact_name", label: "Contact", value: f.contact_name, assess: a.contact_name, issueFields: ["contact_name"] },
    { key: "contact_phone", label: "Contact phone", value: f.contact_phone, assess: a.contact_phone, issueFields: ["contact_phone"] },
    { key: "special_instructions", label: "Instructions", value: f.special_instructions, assess: a.special_instructions, issueFields: ["special_instructions"] },
  ];
}

export function ExtractedFieldsList({ fields, assessments, issues }: Pick<Props, "fields" | "assessments" | "issues">) {
  const rows = buildRows(fields, assessments);
  return (
    <dl className="divide-y divide-line">
      {rows.map((r) => {
        const rowIssues = issues.filter((i) => r.issueFields.includes(i.field));
        return (
          <div key={r.key} className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[10rem_1fr_auto] sm:px-5">
            <dt className="text-[13px] font-medium text-slate-600">{r.label}</dt>
            <dd className="min-w-0">
              <div className="break-words text-slate-900">
                {r.value ?? <span className="text-slate-400">Not provided</span>}
              </div>
              {r.assess.evidence && r.assess.status !== "missing" && <p className="mt-0.5 text-xs text-slate-500">From the request: “{r.assess.evidence}”</p>}
              {r.assess.note && <p className="mt-0.5 text-xs text-slate-600">{r.assess.note}</p>}
              {rowIssues.map((i) => (
                <p key={i.code + i.message} className={clsx("mt-1 flex items-start gap-1.5 text-xs", i.severity === "error" ? "text-red-700" : "text-amber-800")}>
                  {i.severity === "error" ? <XCircle aria-hidden className="mt-px size-3.5 shrink-0" /> : <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />}
                  <span><span className="sr-only">{i.severity}: </span>{i.message}</span>
                </p>
              ))}
            </dd>
            <dd className="flex items-start gap-2 sm:justify-end">
              <span className={clsx("pt-0.5 text-xs", STATUS_CLS[r.assess.status])}>{r.assess.edited ? "Edited by reviewer" : STATUS_LABEL[r.assess.status]}</span>
              <ConfidenceBadge level={r.assess.confidence} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------

interface ItemDraft {
  id: number;
  description: string;
  quantity: string;
  unit: string;
}

const WINDOWS = ["", "morning", "afternoon", "evening", "specific", "unspecified"];

export function ReviewPanel(props: Props) {
  const { workflowId, canReview, fields, assessments, issues, reasons } = props;
  const [editing, setEditing] = useState(false);
  const blocked = issues.some((i) => i.severity === "error");

  return (
    <section aria-labelledby="extracted-h" className="card">
      <div className="card-header">
        <div>
          <h2 id="extracted-h" className="card-title">{canReview ? "Review required" : "Extracted information"}</h2>
          {canReview && <p className="mt-1 text-sm text-slate-600">Check what the AI extracted. Nothing happens until you approve.</p>}
        </div>
        {canReview && !editing && (
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
            <Pencil aria-hidden className="size-4" /> Edit request
          </button>
        )}
      </div>

      {canReview && !editing && reasons.length > 0 && (
        <div className="border-b border-line bg-amber-50/60 px-4 py-3 sm:px-5">
          <p className="text-[13px] font-semibold text-amber-950">Why this needs your attention</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-950">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {editing ? (
        <EditForm workflowId={workflowId} fields={fields} issues={issues} onDone={() => setEditing(false)} />
      ) : (
        <>
          <ExtractedFieldsList fields={fields} assessments={assessments} issues={issues} />
          {canReview && <DecisionBar workflowId={workflowId} blocked={blocked} />}
        </>
      )}
    </section>
  );
}

function DecisionBar({ workflowId, blocked }: { workflowId: string; blocked: boolean }) {
  const [approveState, approve] = useActionState(approveAction.bind(null, workflowId), {} as ActionState);
  const [rejectState, reject] = useActionState(rejectAction.bind(null, workflowId), {} as ActionState);
  const [rejecting, setRejecting] = useState(false);
  const commentId = useId();
  const error = approveState.error ?? rejectState.error;

  return (
    <div className="border-t border-line bg-slate-50/70 px-4 py-4 sm:px-5">
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {blocked && (
        <div className="mb-3">
          <Alert tone="warning" title="Approval is blocked">Fix the validation errors above by editing the request. Approval re-runs validation on the server.</Alert>
        </div>
      )}
      {rejecting ? (
        <form action={reject} className="space-y-3">
          <div>
            <label className="label" htmlFor={commentId}>Reason for rejecting (optional)</label>
            <textarea id={commentId} name="comment" rows={2} maxLength={1000} className="input" />
          </div>
          <div className="flex flex-wrap gap-2">
            <SubmitButton className="btn btn-danger" pendingLabel="Rejecting…"><X aria-hidden className="size-4" /> Confirm rejection</SubmitButton>
            <button type="button" className="btn btn-secondary" onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <form action={approve} className="space-y-3">
          <div>
            <label className="label" htmlFor={`${commentId}-a`}>Note for the audit trail (optional)</label>
            <input id={`${commentId}-a`} name="comment" maxLength={1000} className="input" placeholder="e.g. Confirmed delivery window with customer by phone" />
          </div>
          <div className="flex flex-wrap gap-2">
            <SubmitButton className="btn btn-success" disabled={blocked} pendingLabel="Approving and running action…">
              <Check aria-hidden className="size-4" /> Approve
            </SubmitButton>
            <button type="button" className="btn btn-danger" onClick={() => setRejecting(true)}>Reject</button>
          </div>
        </form>
      )}
    </div>
  );
}

function EditForm({ workflowId, fields, issues, onDone }: { workflowId: string; fields: ExtractedFields; issues: ValidationIssue[]; onDone: () => void }) {
  const [state, action] = useActionState(async (prev: ActionState, fd: FormData) => {
    const result = await editFieldsAction(workflowId, prev, fd);
    if (result.ok) onDone();
    return result;
  }, {} as ActionState);
  const [items, setItems] = useState<ItemDraft[]>(() =>
    (fields.items.length ? fields.items : [{ description: "", quantity: null, unit: null }]).map((i, n) => ({ id: n, description: i.description, quantity: i.quantity === null ? "" : String(i.quantity), unit: i.unit ?? "" })),
  );
  const [nextId, setNextId] = useState(items.length);
  const fe = state.fieldErrors ?? {};
  const err = (field: string) => issues.find((i) => i.field === field && i.severity === "error")?.message;
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;

  const text = (name: keyof ExtractedFields, label: string, extra: { type?: string; placeholder?: string; autoComplete?: string } = {}) => (
    <div>
      <label className="label" htmlFor={id(name)}>{label}</label>
      <input id={id(name)} name={name} type={extra.type ?? "text"} defaultValue={(fields[name] as string | null) ?? ""} placeholder={extra.placeholder} autoComplete={extra.autoComplete ?? "off"} className="input" aria-invalid={Boolean(fe[name])} aria-describedby={err(name) ? `${id(name)}-e` : undefined} />
      {err(name) && <p id={`${id(name)}-e`} className="hint text-red-700">{err(name)}</p>}
      <FieldError id={`${id(name)}-fe`} message={fe[name]} />
    </div>
  );

  return (
    <form action={action} className="space-y-4 px-4 py-4 sm:px-5" noValidate>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {text("customer", "Customer")}
        {text("address", "Delivery address")}
        {text("requested_date", "Requested date", { type: "date" })}
        <div>
          <label className="label" htmlFor={id("win")}>Time window</label>
          <select id={id("win")} name="requested_time_window" defaultValue={fields.requested_time_window ?? ""} className="input">
            {WINDOWS.map((w) => (
              <option key={w} value={w}>{w === "" ? "Not set" : w[0]!.toUpperCase() + w.slice(1)}</option>
            ))}
          </select>
        </div>
        {text("requested_time_start", "Start time", { type: "time" })}
        {text("requested_time_end", "End time", { type: "time" })}
        {text("contact_name", "Contact name", { autoComplete: "off" })}
        {text("contact_phone", "Contact phone", { type: "tel", placeholder: "519-555-0100" })}
      </div>
      <div className="sm:col-span-2">{text("special_instructions", "Instructions")}</div>

      <fieldset>
        <legend className="label">Items</legend>
        <div className="space-y-2">
          {items.map((it, idx) => (
            <div key={it.id} className="grid grid-cols-[1fr_5.5rem_7rem_auto] items-end gap-2">
              <div>
                <label className="sr-only" htmlFor={id(`d${it.id}`)}>Item {idx + 1} description</label>
                <input id={id(`d${it.id}`)} name={`item_description_${idx}`} defaultValue={it.description} placeholder="Description" className="input" />
              </div>
              <div>
                <label className="sr-only" htmlFor={id(`q${it.id}`)}>Item {idx + 1} quantity</label>
                <input id={id(`q${it.id}`)} name={`item_quantity_${idx}`} type="number" step="any" defaultValue={it.quantity} placeholder="Qty" className="input" />
              </div>
              <div>
                <label className="sr-only" htmlFor={id(`u${it.id}`)}>Item {idx + 1} unit</label>
                <input id={id(`u${it.id}`)} name={`item_unit_${idx}`} defaultValue={it.unit} placeholder="Unit" className="input" />
              </div>
              <button type="button" className="btn btn-secondary px-2" aria-label={`Remove item ${idx + 1}`} onClick={() => setItems((l) => (l.length > 1 ? l.filter((x) => x.id !== it.id) : l))} disabled={items.length === 1}>
                <Trash2 aria-hidden className="size-4" />
              </button>
            </div>
          ))}
        </div>
        {err("items") && <p className="hint text-red-700">{err("items")}</p>}
        <button type="button" className="btn btn-secondary mt-2" onClick={() => { setItems((l) => [...l, { id: nextId, description: "", quantity: "", unit: "" }]); setNextId((n) => n + 1); }}>
          <Plus aria-hidden className="size-4" /> Add item
        </button>
      </fieldset>

      <p className="text-xs text-slate-600">Every change is recorded in the audit trail. The request is re-validated when you save.</p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        <button type="button" className="btn btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
