import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold text-slate-900">Create your account</h1>
      <p className="mb-6 mt-1 text-sm text-slate-600">Each account has its own private workspace.</p>
      <RegisterForm />
    </>
  );
}
