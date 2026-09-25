import { z } from "zod";

/**
 * The contract every AI provider must satisfy. All objects are `.strict()`:
 * an unexpected field is treated as a malformed response and rejected.
 */

export const FIELD_NAMES = [
  "customer",
  "address",
  "requested_date",
  "requested_time_window",
  "requested_time_start",
  "requested_time_end",
  "items",
  "contact_name",
  "contact_phone",
  "special_instructions",
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** known = stated in the text · inferred = derived (e.g. "Friday" → a date) · missing · ambiguous */
export const FIELD_STATUSES = ["known", "inferred", "missing", "ambiguous"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** A qualitative AI confidence estimate. It is NOT a calibrated probability. */
export const CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const TIME_WINDOWS = ["morning", "afternoon", "evening", "specific", "unspecified"] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM (24h)");

export const itemSchema = z
  .object({
    description: z.string().trim().min(1).max(200),
    quantity: z.number().finite().nullable(),
    unit: z.string().trim().max(40).nullable(),
  })
  .strict();
export type Item = z.infer<typeof itemSchema>;

export const fieldsSchema = z
  .object({
    customer: z.string().trim().max(200).nullable(),
    address: z.string().trim().max(300).nullable(),
    requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
    requested_time_window: z.enum(TIME_WINDOWS).nullable(),
    requested_time_start: time.nullable(),
    requested_time_end: time.nullable(),
    items: z.array(itemSchema).max(50),
    contact_name: z.string().trim().max(120).nullable(),
    contact_phone: z.string().trim().max(40).nullable(),
    special_instructions: z.string().trim().max(500).nullable(),
  })
  .strict();
export type ExtractedFields = z.infer<typeof fieldsSchema>;

export const assessmentSchema = z
  .object({
    status: z.enum(FIELD_STATUSES),
    confidence: z.enum(CONFIDENCE_LEVELS),
    /** Short verbatim quote from the source text supporting the value. */
    evidence: z.string().max(300).nullable(),
    note: z.string().max(300).nullable(),
  })
  .strict();
export type FieldAssessment = z.infer<typeof assessmentSchema>;

const assessmentsShape = Object.fromEntries(FIELD_NAMES.map((n) => [n, assessmentSchema])) as Record<FieldName, typeof assessmentSchema>;

export const extractionSchema = z
  .object({
    fields: fieldsSchema,
    field_assessments: z.object(assessmentsShape).strict(),
    missing_information: z.array(z.string().trim().min(1).max(200)).max(20),
    ambiguities: z.array(z.object({ field: z.enum(FIELD_NAMES), note: z.string().max(300) }).strict()).max(20),
    requires_human_review: z.boolean(),
    reason: z.string().trim().max(500),
    recommended_action: z.enum(["approve", "review", "request_more_information"]),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;
export type FieldAssessments = Extraction["field_assessments"];

/** JSON Schema handed to providers that support structured output / tool use. */
export function extractionJsonSchema() {
  return z.toJSONSchema(extractionSchema, { target: "draft-7" }) as Record<string, unknown>;
}

/** Editable fields accepted from a human reviewer (subset that is meaningful to edit). */
export const editableFieldsSchema = fieldsSchema.partial();
