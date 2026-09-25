import { formatClock, formatLongDate } from "@/lib/dates";
import type { ExtractedFields } from "@/lib/ai/schema";

export interface ActionContext {
  workflowId: string;
  fields: ExtractedFields;
}

export interface ActionResult {
  kind: "customer_confirmation";
  subject: string;
  body: string;
  /** Always states honestly what happened to the message. */
  delivery: string;
}

/** Thrown by providers with a message that is safe to show users. */
export class ActionError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "ActionError";
  }
}

export interface ActionProvider {
  readonly name: string;
  /** "simulated" providers perform no external side effects. */
  readonly mode: "simulated" | "live";
  execute(ctx: ActionContext): Promise<ActionResult>;
}

export function describeTime(f: ExtractedFields): string {
  if (f.requested_time_start && f.requested_time_end) return `${formatClock(f.requested_time_start)} – ${formatClock(f.requested_time_end)}`;
  if (f.requested_time_start) return `From ${formatClock(f.requested_time_start)}`;
  if (f.requested_time_window && f.requested_time_window !== "unspecified" && f.requested_time_window !== "specific") {
    return `${f.requested_time_window[0]!.toUpperCase()}${f.requested_time_window.slice(1)} (time to be confirmed)`;
  }
  return "To be confirmed";
}

export const describeItems = (f: ExtractedFields) =>
  f.items.map((i) => `${i.quantity ?? "?"}${i.unit ? ` ${i.unit}` : ""} of ${i.description}`).join("; ");

/**
 * Portfolio-safe action: renders the customer confirmation and records it.
 * Nothing is emailed, texted or posted anywhere. A live provider would implement the same interface.
 */
export class SimulatedConfirmationProvider implements ActionProvider {
  readonly name = "simulated-confirmation";
  readonly mode = "simulated" as const;

  async execute({ workflowId, fields }: ActionContext): Promise<ActionResult> {
    const lines = [
      "Delivery request approved.",
      "",
      `Customer: ${fields.customer}`,
      `Delivery address: ${fields.address}`,
      `Date: ${fields.requested_date ? formatLongDate(fields.requested_date) : "To be confirmed"}`,
      `Time: ${describeTime(fields)}`,
      `Items: ${describeItems(fields)}`,
    ];
    if (fields.contact_name) lines.push(`Contact: ${fields.contact_name}${fields.contact_phone ? ` (${fields.contact_phone})` : ""}`);
    if (fields.special_instructions) lines.push(`Instructions: ${fields.special_instructions}`);
    lines.push("", `Reference: ${workflowId.slice(-8).toUpperCase()}`);
    return {
      kind: "customer_confirmation",
      subject: `Delivery confirmed — ${fields.customer}`,
      body: lines.join("\n"),
      delivery: "SIMULATED — generated and recorded only. No message was sent to anyone.",
    };
  }
}
