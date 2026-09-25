"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { editableFieldsSchema } from "@/lib/ai/schema";
import { requireUser } from "@/lib/auth/current-user";
import { DocumentError, inspectUpload } from "@/lib/documents/extract";
import { logger } from "@/lib/logger";
import { appLimiters } from "@/lib/rate-limits";
import { defaultDeps } from "@/lib/workflow/core";
import { parseEditForm } from "@/lib/workflow/edit-form";
import { WorkflowError } from "@/lib/workflow/errors";
import { approveWorkflow, editWorkflowFields, rejectWorkflow, retryWorkflow, submitWorkflow, type CreateWorkflowInput } from "@/lib/workflow/service";
import type { ActionState } from "./types";

const MAX_PASTE = 20_000;

function toState(e: unknown, fallback = "Something went wrong. Please try again."): ActionState {
  if (e instanceof WorkflowError) return { error: e.userMessage };
  if (e instanceof DocumentError) return { error: e.userMessage };
  logger.error("action.unexpected", { error: e });
  return { error: fallback };
}

const versionOf = (formData: FormData) => {
  const raw = formData.get("version");
  return typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
};

async function submit(userId: string, input: Pick<CreateWorkflowInput, "kind" | "text" | "fileName" | "mimeType" | "sizeBytes" | "rawBytes">, source: "PASTE" | "UPLOAD") {
  if (!appLimiters.createByUser.check(userId).allowed) throw new WorkflowError("BAD_INPUT", "You are submitting requests too quickly. Wait a moment and try again.");
  const created = await submitWorkflow(defaultDeps(), { userId, actor: { type: "USER", id: userId }, source, ...input });
  return created.id;
}

export async function createFromTextAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const text = String(formData.get("text") ?? "");
  if (!text.trim()) return { fieldErrors: { text: "Paste the request text to continue." } };
  if (text.length > MAX_PASTE) return { fieldErrors: { text: `Text is too long (limit ${MAX_PASTE.toLocaleString("en-CA")} characters).` } };
  let id: string;
  try {
    id = await submit(user.id, { kind: "text", text }, "PASTE");
  } catch (e) {
    return toState(e);
  }
  redirect(`/workflows/${id}`);
}

export async function createFromUploadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { file: "Choose a file to upload." } };
  let id: string;
  try {
    // Cheap checks only on the request path; PDF parsing happens in the background job (isolated worker thread).
    const doc = await inspectUpload(file);
    id =
      doc.kind === "pdf"
        ? await submit(user.id, { kind: "document", text: "", rawBytes: doc.bytes, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes }, "UPLOAD")
        : await submit(user.id, { kind: "document", text: doc.text, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes }, "UPLOAD");
  } catch (e) {
    return toState(e);
  }
  redirect(`/workflows/${id}`);
}

export async function editFieldsAction(workflowId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const updates = parseEditForm(formData);
  const check = editableFieldsSchema.safeParse(updates);
  if (!check.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of check.error.issues) fieldErrors[String(issue.path[0])] ??= "Check this value.";
    return { error: "Some values are not valid. Check the highlighted fields.", fieldErrors };
  }
  try {
    const { changes } = await editWorkflowFields(defaultDeps(), {
      workflowId,
      userId: user.id,
      actor: { type: "USER", id: user.id },
      updates,
      expectedVersion: versionOf(formData),
    });
    revalidatePath(`/workflows/${workflowId}`);
    return { ok: `Saved ${changes.length} change${changes.length === 1 ? "" : "s"}.` };
  } catch (e) {
    if (e instanceof WorkflowError && e.code === "NO_CHANGES") return { ok: "No changes to save." };
    return toState(e);
  }
}

export async function approveAction(workflowId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const version = versionOf(formData);
  if (version === undefined) return { error: "This page is out of date. Reload and try again." };
  try {
    await approveWorkflow(defaultDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id }, expectedVersion: version, comment: String(formData.get("comment") ?? "") });
  } catch (e) {
    return toState(e);
  }
  revalidatePath(`/workflows/${workflowId}`);
  revalidatePath("/dashboard");
  return { ok: "Approved." };
}

export async function rejectAction(workflowId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await rejectWorkflow(defaultDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id }, comment: String(formData.get("comment") ?? ""), expectedVersion: versionOf(formData) });
  } catch (e) {
    return toState(e);
  }
  revalidatePath(`/workflows/${workflowId}`);
  revalidatePath("/dashboard");
  return { ok: "Rejected." };
}

export async function retryAction(workflowId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireUser();
  try {
    await retryWorkflow(defaultDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id } });
  } catch (e) {
    return toState(e);
  }
  revalidatePath(`/workflows/${workflowId}`);
  revalidatePath("/dashboard");
  return { ok: "Retry finished." };
}
