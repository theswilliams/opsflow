"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, registerAction } from "@/app/actions/auth";
import type { ActionState } from "@/app/actions/types";
import { Alert } from "./ui";
import { FieldError, SubmitButton } from "./form";

const initial: ActionState = {};

export function LoginForm() {
  const [state, action] = useActionState(loginAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className="input" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      <SubmitButton className="btn btn-primary w-full" pendingLabel="Signing in…">Sign in</SubmitButton>
      <p className="text-center text-sm text-slate-600">
        New to OpsFlow? <Link href="/register" className="font-medium text-brand hover:underline">Create an account</Link>
      </p>
    </form>
  );
}

export function RegisterForm() {
  const [state, action] = useActionState(registerAction, initial);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input id="name" name="name" autoComplete="name" required className="input" aria-invalid={Boolean(fe.name)} aria-describedby={fe.name ? "name-err" : undefined} />
        <FieldError id="name-err" message={fe.name} />
      </div>
      <div>
        <label className="label" htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" aria-invalid={Boolean(fe.email)} aria-describedby={fe.email ? "email-err" : undefined} />
        <FieldError id="email-err" message={fe.email} />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} className="input" aria-invalid={Boolean(fe.password)} aria-describedby="password-hint password-err" />
        <p id="password-hint" className="hint">At least 10 characters.</p>
        <FieldError id="password-err" message={fe.password} />
      </div>
      <SubmitButton className="btn btn-primary w-full" pendingLabel="Creating account…">Create account</SubmitButton>
      <p className="text-center text-sm text-slate-600">
        Already registered? <Link href="/login" className="font-medium text-brand hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
