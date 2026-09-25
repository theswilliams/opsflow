"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { editableFieldsSchema } from "@/lib/ai/schema";
import { requireUser } from "@/lib/auth/current-user";
import { DocumentError, extractDocumentText } from "@/lib/documents/extract";
import { logger } from "@/lib/logger";
import { appLimiters } from "@/lib/rate-limits";
import { parseEditForm } from "@/lib/workflow/edit-form";
import { WorkflowError } from "@/lib/workflow/errors";
import { approveWorkflow, createWorkflow, defaultDeps, editWorkflowFields, lightDeps, processWorkflow, rejectWorkflow, retryWorkflow } from "@/lib/workflow/service";
import type { ActionState } from "./types";

const MAX_PASTE = 20_000;

function toState(e: unknown, fallback = "Something went wrong. Please try again."): ActionState {
  if (e instanceof WorkflowError) return { error: e.userMessage };
  if (e instanceof DocumentError) return { error: e.userMessage };
  logger.error("action.unexpected", { error: e });
  return { error: fallback };
}

async function submit(userId: string, input: { kind: "text" | "document"; text: string; fileName?: string; mimeType?: string; sizeBytes?: number }, source: "PASTE" | "UPLOAD") {
  if (!appLimiters.createByUser.check(userId).allowed) throw new WorkflowError("BAD_INPUT", "You are submitting requests too quickly. Wait a moment and try again.");
  const deps = defaultDeps();
  const actor = { type: "USER", id: userId } as const;
  const created = await createWorkflow(deps, { userId, actor, source, ...input });
  await processWorkflow(deps, { workflowId: created.id, userId, actor });
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
    const doc = await extractDocumentText(file);
    id = await submit(user.id, { kind: "document", text: doc.text, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes }, "UPLOAD");
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
    const { changes } = await editWorkflowFields(lightDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id }, updates });
    revalidatePath(`/workflows/${workflowId}`);
    return { ok: `Saved ${changes.length} change${changes.length === 1 ? "" : "s"}.` };
  } catch (e) {
    if (e instanceof WorkflowError && e.code === "NO_CHANGES") return { ok: "No changes to save." };
    return toState(e);
  }
}

export async function approveAction(workflowId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await approveWorkflow(lightDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id }, comment: String(formData.get("comment") ?? "") });
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
    await rejectWorkflow(lightDeps(), { workflowId, userId: user.id, actor: { type: "USER", id: user.id }, comment: String(formData.get("comment") ?? "") });
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
