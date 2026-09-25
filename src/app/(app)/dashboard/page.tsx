import { AlertTriangle, ArrowRight, Bell, CheckCircle2, FilePlus2, Hourglass, Layers, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader, StatusPill } from "@/components/ui";
import { Pagination, WorkflowFilters, WorkflowTable } from "@/components/workflow-table";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { ageLabel, ageTone, formatDateTime, formatTime, relativeTime, shortId } from "@/lib/format";
import { attentionRequired, dashboardStats, listWorkflows, recentActivity, recentNotifications } from "@/lib/workflow/queries";

export const metadata: Metadata = { title: "Dashboard" };

type SearchParams = Promise<{ q?: string; status?: string; page?: string }>;

function Kpi({ label, value, Icon, tone, href }: { label: string; value: number; Icon: typeof Layers; tone: string; href?: string }) {
  const body = (
    <div className="card flex items-center gap-4 px-4 py-4 sm:px-5">
      <span className={`grid size-10 shrink-0 place-items-center rounded-md ${tone}`}>
        <Icon aria-hidden className="size-5" />
      </span>
      <div>
        <p className="text-2xl font-semibold leading-none text-slate-900">{value}</p>
        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      </div>
    </div>
  );
  return href ? <Link href={href} className="block rounded-lg transition-shadow hover:shadow-md">{body}</Link> : body;
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const page = Number(sp.page) || 1;
  const db = getDb();
  const [stats, attention, activity, list, notifications] = await Promise.all([
    dashboardStats(db, user.id),
    attentionRequired(db, user.id),
    recentActivity(db, user.id),
    listWorkflows(db, user.id, { q: sp.q, status: sp.status, page }),
    recentNotifications(db, user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Requests moving through extraction, validation, human review and automation."
        actions={
          <Link href="/workflows/new" className="btn btn-primary">
            <FilePlus2 aria-hidden className="size-4" /> New workflow
          </Link>
        }
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total workflows" value={stats.total} Icon={Layers} tone="bg-slate-100 text-slate-700" />
        <Kpi label="Pending review" value={stats.pendingReview} Icon={Hourglass} tone="bg-amber-100 text-amber-800" href="/dashboard?status=REVIEW_REQUIRED" />
        <Kpi label="Completed" value={stats.completed} Icon={CheckCircle2} tone="bg-emerald-100 text-emerald-800" href="/dashboard?status=COMPLETED" />
        <Kpi label="Failed" value={stats.failed} Icon={XCircle} tone="bg-red-100 text-red-800" href="/dashboard?status=FAILED" />
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="attention-h" className="card">
          <div className="card-header">
            <h2 id="attention-h" className="card-title flex items-center gap-2">
              <AlertTriangle aria-hidden className="size-4 text-amber-600" /> Attention required
            </h2>
            {attention.length > 0 && <span className="text-xs text-slate-500">{attention.length} shown</span>}
          </div>
          {attention.length === 0 ? (
            <EmptyState title="Nothing needs attention" icon={<CheckCircle2 aria-hidden className="size-8" />}>
              Workflows that are ambiguous, invalid or failed will appear here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((w) => (
                <li key={w.id}>
                  <Link href={`/workflows/${w.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">{w.customerName ?? "Unknown customer"}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-600">
                        {w.status === "FAILED" ? (w.failureReason ?? "Failed") : (w.attentionReason ?? "Needs a person to review before anything happens")}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {w.status === "REVIEW_REQUIRED" && w.reviewRequiredAt && (
                        <span
                          className={`hidden text-xs font-medium sm:inline ${ageTone(w.reviewRequiredAt) === "urgent" ? "text-red-700" : ageTone(w.reviewRequiredAt) === "warn" ? "text-amber-800" : "text-slate-500"}`}
                          title={ageTone(w.reviewRequiredAt) === "urgent" ? "Overdue: waiting more than 72 hours" : ageTone(w.reviewRequiredAt) === "warn" ? "Waiting more than 24 hours" : "Time since review was requested"}
                        >
                          {ageTone(w.reviewRequiredAt) === "urgent" ? "Overdue · " : ""}
                          {ageLabel(w.reviewRequiredAt)}
                        </span>
                      )}
                      <StatusPill status={w.status} />
                      <ArrowRight aria-hidden className="size-4 text-slate-400" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="activity-h" className="card">
          <div className="card-header">
            <h2 id="activity-h" className="card-title">Recent activity</h2>
          </div>
          {activity.length === 0 ? (
            <EmptyState title="No activity yet">Events appear here as workflows are processed.</EmptyState>
          ) : (
            <ol className="divide-y divide-line">
              {activity.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
                  <time dateTime={e.createdAt.toISOString()} title={formatDateTime(e.createdAt)} className="w-[4.5rem] shrink-0 pt-px font-mono text-xs text-slate-500">
                    {formatTime(e.createdAt)}
                  </time>
                  <div className="min-w-0 text-sm">
                    <p className="text-slate-800">{e.message}</p>
                    <p className="truncate text-xs text-slate-500">
                      {e.workflow ? (
                        <Link href={`/workflows/${e.workflow.id}`} className="hover:underline">
                          {e.workflow.customerName ?? shortId(e.workflow.id)}
                        </Link>
                      ) : null}{" "}
                      · {relativeTime(e.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section aria-labelledby="notif-h" className="card mt-6">
        <div className="card-header">
          <h2 id="notif-h" className="card-title flex items-center gap-2"><Bell aria-hidden className="size-4" /> Review notifications</h2>
          <span className="text-xs text-slate-500">Simulated — a real deployment would email or message your dispatch team</span>
        </div>
        {notifications.length === 0 ? (
          <EmptyState title="No notifications yet">You are notified when a request needs review.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {notifications.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                <p className="min-w-0 text-slate-800">
                  {n.workflowId ? <Link href={`/workflows/${n.workflowId}`} className="hover:underline">{n.message}</Link> : n.message}
                </p>
                <time dateTime={n.createdAt.toISOString()} className="shrink-0 text-xs text-slate-500">{relativeTime(n.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="table-h" className="card mt-6">
        <div className="card-header">
          <h2 id="table-h" className="card-title">Workflows</h2>
          <WorkflowFilters q={sp.q} status={sp.status} />
        </div>
        <WorkflowTable rows={list.rows} filtered={Boolean(sp.q || sp.status)} />
        <Pagination page={list.page} pageCount={list.pageCount} q={sp.q} status={sp.status} />
      </section>
    </>
  );
}
