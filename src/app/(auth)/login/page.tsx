import type { Metadata } from "next";
import { LoginForm } from "@/components/auth-forms";
import { isDemoMode } from "@/lib/ai";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Access your workflows and approvals.</p>
      <LoginForm />
      {isDemoMode() && (
        <p className="mt-8 rounded-md border border-line bg-white p-3 text-xs text-slate-600">
          <strong className="text-slate-800">Demo mode.</strong> After <code className="font-mono">npm run db:seed</code>, sign in as{" "}
          <code className="font-mono">demo@opsflow.test</code> with the <code className="font-mono">DEMO_USER_PASSWORD</code> from your <code className="font-mono">.env</code>.
        </p>
      )}
    </>
  );
}
