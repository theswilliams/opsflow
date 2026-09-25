import type { Metadata } from "next";
import { NewWorkflowForm } from "@/components/new-workflow-form";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "New workflow" };

export default function NewWorkflowPage() {
  return (
    <>
      <PageHeader title="New workflow" description="Give OpsFlow a messy request. It will extract structured data, validate it, and hand it to a person for review." />
      <div className="max-w-3xl">
        <NewWorkflowForm />
      </div>
    </>
  );
}
