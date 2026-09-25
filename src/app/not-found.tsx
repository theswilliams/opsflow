import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="font-mono text-sm text-slate-500">404</p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900">Not found</h1>
      <p className="mt-2 text-sm text-slate-600">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/dashboard" className="btn btn-primary mt-5">Back to dashboard</Link>
    </div>
  );
}
