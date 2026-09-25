import { TIME_WINDOWS } from "@/lib/ai/schema";

const nullable = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/** Builds the edit payload from the review form. Structure and value validation happen in the service. */
export function parseEditForm(formData: FormData) {
  const items: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    const description = nullable(formData.get(`item_description_${i}`));
    const quantityRaw = nullable(formData.get(`item_quantity_${i}`));
    const unit = nullable(formData.get(`item_unit_${i}`));
    if (description === null && quantityRaw === null && unit === null) continue;
    items.push({ description: description ?? "", quantity: quantityRaw === null ? null : Number(quantityRaw), unit });
  }
  const window = nullable(formData.get("requested_time_window"));
  return {
    customer: nullable(formData.get("customer")),
    address: nullable(formData.get("address")),
    requested_date: nullable(formData.get("requested_date")),
    requested_time_window: window && (TIME_WINDOWS as readonly string[]).includes(window) ? window : null,
    requested_time_start: nullable(formData.get("requested_time_start")),
    requested_time_end: nullable(formData.get("requested_time_end")),
    items,
    contact_name: nullable(formData.get("contact_name")),
    contact_phone: nullable(formData.get("contact_phone")),
    special_instructions: nullable(formData.get("special_instructions")),
  };
}
