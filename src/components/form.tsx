"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** Submit button that disables itself and announces progress while the server action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
  ...rest
}: { children: ReactNode; pendingLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={clsx(className)} disabled={pending || rest.disabled} aria-busy={pending} {...rest}>
      {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs font-medium text-red-700">
      {message}
    </p>
  );
}
