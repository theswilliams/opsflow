"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-600">
        We couldn&apos;t load this page. Your data has not been changed.
        {error.digest && <span className="mt-1 block font-mono text-xs text-slate-500">Reference: {error.digest}</span>}
      </p>
      <button type="button" onClick={reset} className="btn btn-primary mt-5">Try again</button>
    </div>
  );
}
