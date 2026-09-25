import type { Db } from "@/lib/db";
import { ExtractionError, type AttemptUsage } from "./extract";

/**
 * AI spend tracking and ceilings (per user).
 *
 * Every provider request is recorded — including failed ones, because providers bill for them — and
 * checked against configurable budgets BEFORE the next request is made. Costs are only estimated when
 * per-million-token prices are configured AND the provider reported token counts; otherwise the cost is
 * recorded as unknown (null), never invented.
 *
 * The check-then-record sequence is not one atomic step, so simultaneous jobs can overshoot a ceiling by
 * at most the number of concurrently running jobs. It is a spend guard rail, not a billing system.
 */
export interface Budget {
  /** Requests per rolling 24 h. 0 = unlimited. */
  dailyRequests: number;
  /** Input+output tokens per rolling 24 h. 0 = unlimited. */
  dailyTokens: number;
  /** Estimated USD per rolling 30 days; enforced only for requests with a known cost. 0 = unlimited. */
  monthlyCostUsd: number;
}

export interface Prices {
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}

const DAY = 24 * 60 * 60 * 1000;

export function estimateCostMicroUsd(u: { inputTokens?: number | null; outputTokens?: number | null }, prices: Prices): number | null {
  if (u.inputTokens == null || u.outputTokens == null) return null;
  if (prices.inputUsdPerMTok == null || prices.outputUsdPerMTok == null) return null;
  return Math.round(u.inputTokens * prices.inputUsdPerMTok + u.outputTokens * prices.outputUsdPerMTok);
}

export async function usageSummary(db: Db, userId: string, now: Date, windowMs = DAY) {
  const since = new Date(now.getTime() - windowMs);
  const agg = await db.aiUsage.aggregate({
    where: { userId, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, costMicroUsd: true },
  });
  return {
    requests: agg._count._all,
    tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0),
    costMicroUsd: agg._sum.costMicroUsd ?? 0,
  };
}

export async function assertWithinBudget(db: Db, userId: string, budget: Budget, now: Date) {
  const day = await usageSummary(db, userId, now, DAY);
  if (budget.dailyRequests > 0 && day.requests >= budget.dailyRequests) {
    throw new ExtractionError("BUDGET_EXCEEDED", "Your daily AI request limit has been reached. Try again tomorrow or contact an administrator.");
  }
  if (budget.dailyTokens > 0 && day.tokens >= budget.dailyTokens) {
    throw new ExtractionError("BUDGET_EXCEEDED", "Your daily AI usage limit has been reached. Try again tomorrow or contact an administrator.");
  }
  if (budget.monthlyCostUsd > 0) {
    const month = await usageSummary(db, userId, now, 30 * DAY);
    if (month.costMicroUsd >= budget.monthlyCostUsd * 1_000_000) {
      throw new ExtractionError("BUDGET_EXCEEDED", "Your monthly AI spending limit has been reached. Contact an administrator.");
    }
  }
}

export async function recordUsage(
  db: Db,
  args: { userId: string; workflowId: string | null; provider: string; usage: AttemptUsage; prices: Prices; now: Date },
) {
  const { usage } = args;
  await db.aiUsage.create({
    data: {
      userId: args.userId,
      workflowId: args.workflowId,
      provider: args.provider,
      model: usage.model,
      ok: usage.ok,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      costMicroUsd: estimateCostMicroUsd(usage, args.prices),
      createdAt: args.now,
    },
  });
}
