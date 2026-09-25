import Link from "next/link";
import { Search } from "lucide-react";
import type { Workflow } from "@/generated/prisma/client";
import { formatDateTime, shortId, TYPE_LABEL } from "@/lib/format";
import { ConfidenceBadge, EmptyState, StatusPill, STATUS_OPTIONS } from "./ui";

export function WorkflowFilters({ q, status }: { q?: string; status?: string }) {
  const active = Boolean(q || status);
  return (
    <form method="get" action="/dashboard" role="search" aria-label="Filter workflows" className="flex flex-wrap items-end gap-2">
      <div className="min-w-44 flex-1 sm:flex-none">
        <label className="sr-only" htmlFor="q">Search by customer or ID</label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-slate-400" />
          <input id="q" name="q" defaultValue={q} placeholder="Customer or ID" maxLength={80} className="input pl-8 sm:w-56" />
        </div>
      </div>
      <div>
        <label className="sr-only" htmlFor="status">Status</label>
        <select id="status" name="status" defaultValue={status ?? ""} className="input pr-8">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-secondary">Apply</button>
      {active && (
        <Link href="/dashboard" className="btn btn-secondary">Clear</Link>
      )}
    </form>
  );
}

export function WorkflowTable({ rows, filtered }: { rows: Workflow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState title={filtered ? "No workflows match these filters" : "No workflows yet"}>
        {filtered ? "Try a different search or clear the filters." : "Create your first workflow by pasting a request or uploading a document."}
        {!filtered && (
          <div className="mt-4">
            <Link href="/workflows/new" className="btn btn-primary">New workflow</Link>
          </div>
        )}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
      <table className="w-full text-sm">
        <caption className="sr-only">Workflows</caption>
        <thead className="border-b border-line bg-slate-50/70">
          <tr>
            {["ID", "Type", "Customer", "Status", "Confidence", "Created", "Updated"].map((h) => (
              <th key={h} scope="col" className="th">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((w) => (
            <tr key={w.id} className="hover:bg-slate-50">
              <td className="td">
                <Link href={`/workflows/${w.id}`} className="font-mono text-[13px] font-medium text-brand hover:underline">{shortId(w.id)}</Link>
              </td>
              <td className="td text-slate-600">{TYPE_LABEL[w.type] ?? w.type}</td>
              <td className="td max-w-56 truncate font-medium text-slate-900">{w.customerName ?? <span className="font-normal text-slate-400">Unknown</span>}</td>
              <td className="td"><StatusPill status={w.status} /></td>
              <td className="td"><ConfidenceBadge level={w.overallConfidence} /></td>
              <td className="td whitespace-nowrap text-slate-600">{formatDateTime(w.createdAt)}</td>
              <td className="td whitespace-nowrap text-slate-600">{formatDateTime(w.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <ul className="divide-y divide-line lg:hidden">
        {rows.map((w) => (
          <li key={w.id}>
            <Link href={`/workflows/${w.id}`} className="block px-4 py-3 hover:bg-slate-50">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate font-medium text-slate-900">{w.customerName ?? "Unknown customer"}</p>
                <StatusPill status={w.status} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                <span className="font-mono">{shortId(w.id)}</span>
                <span>{TYPE_LABEL[w.type] ?? w.type}</span>
                <span>{formatDateTime(w.createdAt)}</span>
                <ConfidenceBadge level={w.overallConfidence} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pagination({ page, pageCount, q, status }: { page: number; pageCount: number; q?: string; status?: string }) {
  if (pageCount <= 1) return null;
  const href = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/dashboard${qs ? `?${qs}` : ""}`;
  };
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
      <span className="text-slate-600">Page {page} of {pageCount}</span>
      <div className="flex gap-2">
        {page > 1 ? <Link className="btn btn-secondary" href={href(page - 1)}>Previous</Link> : <span className="btn btn-secondary pointer-events-none opacity-50" aria-disabled>Previous</span>}
        {page < pageCount ? <Link className="btn btn-secondary" href={href(page + 1)}>Next</Link> : <span className="btn btn-secondary pointer-events-none opacity-50" aria-disabled>Next</span>}
      </div>
    </nav>
  );
}
