"use client";

import { useActionState } from "react";
import { deleteAccountAction } from "@/app/actions/account";
import type { ActionState } from "@/app/actions/types";
import { FieldError, SubmitButton } from "./form";
import { Alert } from "./ui";

export function DeleteAccountForm() {
  const [state, action] = useActionState(deleteAccountAction, {} as ActionState);
  return (
    <details className="rounded-md border border-red-200 bg-red-50/40">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-red-800">Delete my account…</summary>
      <form action={action} className="space-y-3 border-t border-red-200 px-4 py-4" noValidate>
        <p className="text-sm text-slate-700">
          This erases your documents, extracted data, credentials and sign-in, and anonymises your account. Audit history is kept with personal details redacted. It cannot be undone — export your data first if you need it.
        </p>
        {state.error && <Alert tone="error">{state.error}</Alert>}
        <div>
          <label className="label" htmlFor="del-password">Password</label>
          <input id="del-password" name="password" type="password" autoComplete="current-password" className="input" required aria-describedby="del-pw-err" />
          <FieldError id="del-pw-err" message={state.fieldErrors?.password} />
        </div>
        <div>
          <label className="label" htmlFor="del-confirm">Type DELETE to confirm</label>
          <input id="del-confirm" name="confirm" autoComplete="off" className="input" required aria-describedby="del-c-err" />
          <FieldError id="del-c-err" message={state.fieldErrors?.confirm} />
        </div>
        <SubmitButton className="btn btn-danger" pendingLabel="Deleting…">Permanently delete my account</SubmitButton>
      </form>
    </details>
  );
}
