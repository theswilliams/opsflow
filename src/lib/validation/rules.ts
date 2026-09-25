import type { Confidence, Extraction, FieldAssessments, FieldName } from "@/lib/ai/schema";
import type { ValidationOutcome } from "./delivery";

/**
 * Business rules — applied AFTER AI extraction and deterministic validation.
 * They decide how much human attention a workflow needs. They never approve anything:
 * approval is always a human act.
 */

export type ConfidenceLevelName = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export const REQUIRED_FIELDS: FieldName[] = ["customer", "address", "requested_date", "items"];
const RANK: Record<Confidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

export interface ReviewDecision {
  needsAttention: boolean;
  reasons: string[];
  overallConfidence: ConfidenceLevelName;
}

/** Overall = the weakest assessment among required fields plus the time window. */
export function overallConfidence(assessments: FieldAssessments): ConfidenceLevelName {
  const considered: FieldName[] = [...REQUIRED_FIELDS, "requested_time_window"];
  let min: Confidence = "high";
  for (const name of considered) {
    const a = assessments[name];
    const effective: Confidence = a.status === "missing" && !REQUIRED_FIELDS.includes(name) ? "high" : a.confidence;
    if (RANK[effective] < RANK[min]) min = effective;
  }
  return min.toUpperCase() as ConfidenceLevelName;
}

export function decideReview(input: {
  requiresHumanReview: boolean;
  aiReason?: string | null;
  assessments: FieldAssessments;
  ambiguities: Extraction["ambiguities"];
  validation: ValidationOutcome;
}): ReviewDecision {
  const reasons: string[] = [];
  if (input.requiresHumanReview && input.aiReason) reasons.push(input.aiReason);
  if (input.validation.errorCount) reasons.push(`${input.validation.errorCount} validation error(s) must be fixed before approval.`);
  const warnings = input.validation.issues.filter((i) => i.severity === "warning");
  for (const w of warnings.slice(0, 3)) reasons.push(w.message);
  for (const a of input.ambiguities) if (!reasons.includes(a.note)) reasons.push(a.note);
  const weak = REQUIRED_FIELDS.filter((n) => RANK[input.assessments[n].confidence] < RANK.medium);
  if (weak.length) reasons.push(`Low AI confidence: ${weak.join(", ")}.`);

  const overall = overallConfidence(input.assessments);
  const needsAttention =
    input.requiresHumanReview || input.validation.errorCount > 0 || warnings.length > 0 || input.ambiguities.length > 0 || overall === "LOW" || overall === "UNKNOWN";
  return { needsAttention, reasons: [...new Set(reasons)], overallConfidence: overall };
}
