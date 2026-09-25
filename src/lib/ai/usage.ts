import type { Prisma } from "@/generated/prisma/client";
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
type Q = Db | Prisma.TransactionClient;

export function estimateCostMicroUsd(u: { inputTokens?: number | null; outputTokens?: number | null }, prices: Prices): number | null {
  if (u.inputTokens == null || u.outputTokens == null) return null;
  if (prices.inputUsdPerMTok == null || prices.outputUsdPerMTok == null) return null;
  return Math.round(u.inputTokens * prices.inputUsdPerMTok + u.outputTokens * prices.outputUsdPerMTok);
}

export async function usageSummary(db: Q, userId: string, now: Date, windowMs = DAY) {
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

export async function assertWithinBudget(db: Q, userId: string, budget: Budget, now: Date) {
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

/**
 * Reserve one request BEFORE calling the provider: under a per-user advisory lock the budget is checked and a
 * placeholder usage row is inserted in the same transaction. Concurrent jobs therefore cannot all pass the check
 * and then overshoot — every in-flight request already counts. (Token/cost ceilings can still overshoot by the
 * tokens of the requests that are in flight at that moment.) A crash after reservation leaves a conservative
 * "pending" row that keeps counting as one request.
 */
export async function reserveUsage(
  db: Db,
  args: { userId: string; workflowId: string | null; provider: string; budget: Budget; now: Date },
): Promise<string> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai:${args.userId}`}, 0))`;
    await assertWithinBudget(tx, args.userId, args.budget, args.now);
    const row = await tx.aiUsage.create({ data: { userId: args.userId, workflowId: args.workflowId, provider: args.provider, model: "pending", ok: false, createdAt: args.now } });
    return row.id;
  });
}

/** Fill in what actually happened for a reserved request. */
export async function completeUsage(db: Db, id: string, usage: AttemptUsage, prices: Prices) {
  await db.aiUsage.update({
    where: { id },
    data: {
      model: usage.model,
      ok: usage.ok,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      costMicroUsd: estimateCostMicroUsd(usage, prices),
    },
  });
}
