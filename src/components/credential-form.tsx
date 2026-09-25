"use client";

import { Copy } from "lucide-react";
import { useActionState, useState } from "react";
import { createCredentialAction } from "@/app/actions/credentials";
import type { ActionState } from "@/app/actions/types";
import { FieldError, SubmitButton } from "./form";
import { Alert } from "./ui";

export function CredentialForm() {
  const [state, action] = useActionState(createCredentialAction, {} as ActionState);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="label">Label</label>
          <input id="label" name="label" maxLength={60} placeholder="n8n production" className="input" aria-invalid={Boolean(state.fieldErrors?.label)} aria-describedby="label-err" />
          <FieldError id="label-err" message={state.fieldErrors?.label} />
        </div>
        <SubmitButton pendingLabel="Creating…">Create credential</SubmitButton>
      </form>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.secret && (
        <Alert tone="warning" title="Copy your signing secret now">
          <p className="mb-2">It is stored encrypted and cannot be shown again.</p>
          <dl className="space-y-1 font-mono text-xs">
            <div className="flex flex-wrap gap-x-2"><dt className="font-sans font-medium">Key ID:</dt><dd className="break-all">{state.secret.keyId}</dd></div>
            <div className="flex flex-wrap gap-x-2"><dt className="font-sans font-medium">Secret:</dt><dd className="break-all">{state.secret.secret}</dd></div>
          </dl>
          <button
            type="button"
            className="btn btn-secondary mt-3"
            onClick={async () => {
              await navigator.clipboard.writeText(state.secret!.secret).catch(() => undefined);
              setCopied(true);
            }}
          >
            <Copy aria-hidden className="size-4" /> {copied ? "Copied" : "Copy secret"}
          </button>
          <span role="status" className="sr-only">{copied ? "Secret copied to clipboard" : ""}</span>
        </Alert>
      )}
    </div>
  );
}
