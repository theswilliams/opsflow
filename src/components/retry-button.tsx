"use client";

import { RotateCcw } from "lucide-react";
import { useActionState } from "react";
import { retryAction } from "@/app/actions/workflows";
import type { ActionState } from "@/app/actions/types";
import { SubmitButton } from "./form";
import { Alert } from "./ui";

export function RetryButton({ workflowId, label }: { workflowId: string; label: string }) {
  const [state, action] = useActionState(retryAction.bind(null, workflowId), {} as ActionState);
  return (
    <form action={action} className="space-y-2">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <SubmitButton className="btn btn-secondary" pendingLabel="Retrying…">
        <RotateCcw aria-hidden className="size-4" /> {label}
      </SubmitButton>
    </form>
  );
}
