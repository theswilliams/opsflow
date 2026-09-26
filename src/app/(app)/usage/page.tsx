import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { usageSummary } from "@/lib/ai/usage";
import { requireUser } from "@/lib/auth/current-user";
import { todayIn } from "@/lib/dates";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatDateTime, shortId } from "@/lib/format";
import { aiUsageOverview } from "@/lib/workflow/queries";

export const metadata: Metadata = { title: "AI usage" };

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;
const n = (v: number) => v.toLocaleString("en-CA");

export default async function UsagePage() {
  const user = await requireUser();
  const env = getEnv();
  const db = getDb();
  const now = new Date();
  const [day, month, overview] = await Promise.all([
    usageSummary(db, user.id, now, 24 * 3_600_000),
    usageSummary(db, user.id, now, 30 * 24 * 3_600_000),
    aiUsageOverview(db, user.id, now, 14),
  ]);
  const priced = env.AI_PRICE_INPUT_USD_PER_MTOK != null && env.AI_PRICE_OUTPUT_USD_PER_MTOK != null;
  const everReportedTokens = overview.rows.some((r) => r.inputTokens != null);

  const byDay = new Map<string, { requests: number; failed: number; tokens: number; cost: number; hasCost: boolean }>();
  for (const r of overview.rows) {
    const key = todayIn(env.BUSINESS_TIMEZONE, r.createdAt);
    const d = byDay.get(key) ?? { requests: 0, failed: 0, tokens: 0, cost: 0, hasCost: false };
    d.requests++;
    if (!r.ok) d.failed++;
    d.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    if (r.costMicroUsd != null) [d.cost, d.hasCost] = [d.cost + r.costMicroUsd, true];
    byDay.set(key, d);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  const budgetLine = (used: number, limit: number, unit: string) => (limit > 0 ? `${n(used)} of ${n(limit)} ${unit} used` : `${n(used)} ${unit} · no limit`);

  return (
    <>
      <PageHeader title="AI usage" description="Every AI request OpsFlow makes on your behalf, recorded whether it succeeded or not. Costs are shown only when the provider reports tokens and prices are configured — never guessed." />

      <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="card px-4 py-4 sm:px-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Last 24 hours</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{n(day.requests)} <span className="text-sm font-normal text-slate-500">requests</span></p>
          <p className="mt-1 text-xs text-slate-600">{budgetLine(day.requests, env.AI_DAILY_REQUEST_BUDGET, "requests")}</p>
        </div>
        <div className="card px-4 py-4 sm:px-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tokens · last 24 hours</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{everReportedTokens ? n(day.tokens) : "—"}</p>
          <p className="mt-1 text-xs text-slate-600">{everReportedTokens ? budgetLine(day.tokens, env.AI_DAILY_TOKEN_BUDGET, "tokens") : "The current provider does not report token counts (the demo mock never does)."}</p>
        </div>
        <div className="card px-4 py-4 sm:px-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Estimated cost · 30 days</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{month.costMicroUsd > 0 ? usd(month.costMicroUsd) : "—"}</p>
          <p className="mt-1 text-xs text-slate-600">
            {priced ? (env.AI_MONTHLY_COST_BUDGET_USD > 0 ? `Limit $${env.AI_MONTHLY_COST_BUDGET_USD}/month` : "No monthly cost limit") : "Not available: set AI_PRICE_INPUT_USD_PER_MTOK and AI_PRICE_OUTPUT_USD_PER_MTOK to enable estimates."}
          </p>
        </div>
      </section>

      <section aria-labelledby="days-h" className="card mt-6">
        <div className="card-header"><h2 id="days-h" className="card-title">Last 14 days</h2></div>
        {days.length === 0 ? (
          <EmptyState title="No AI requests yet">Usage appears here as workflows are processed.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">AI usage by day</caption>
              <thead className="border-b border-line bg-slate-50/70"><tr>{["Day", "Requests", "Failed", "Tokens", "Est. cost"].map((h) => <th key={h} scope="col" className="th">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {days.map(([d, v]) => (
                  <tr key={d}>
                    <td className="td font-mono text-[13px]">{d}</td>
                    <td className="td">{n(v.requests)}</td>
                    <td className="td">{v.failed ? <span className="font-medium text-red-700">{n(v.failed)}</span> : 0}</td>
                    <td className="td">{v.tokens ? n(v.tokens) : "—"}</td>
                    <td className="td">{v.hasCost ? usd(v.cost) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="recent-h" className="card mt-6">
        <div className="card-header"><h2 id="recent-h" className="card-title">Recent requests</h2></div>
        {overview.recent.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {overview.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                <div className="min-w-0">
                  <p className="truncate text-slate-900">
                    {r.workflow ? <Link href={`/workflows/${r.workflow.id}`} className="hover:underline">{r.workflow.customerName ?? shortId(r.workflow.id)}</Link> : "—"}
                  </p>
                  <p className="text-xs text-slate-500">{r.provider} · {r.model} · {formatDateTime(r.createdAt)}</p>
                </div>
                <div className="text-right text-xs text-slate-600">
                  <span className={r.ok ? "text-emerald-800" : "font-medium text-red-700"}>{r.ok ? "ok" : "failed"}</span>
                  {r.inputTokens != null && <> · {n(r.inputTokens + (r.outputTokens ?? 0))} tokens</>}
                  {r.costMicroUsd != null && <> · {usd(r.costMicroUsd)}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
