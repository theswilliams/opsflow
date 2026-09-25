import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { ExtractedFieldsList, ReviewPanel, type ReviewAssessments } from "@/components/review-panel";
import { Alert, ConfidenceBadge, StatusPill } from "@/components/ui";
import { ActionsCard, AiAnalysis, ReviewHistory, SourceCard, Timeline, ValidationCard } from "@/components/workflow-sections";
import type { ExtractedFields } from "@/lib/ai/schema";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { ageLabel, formatFullDateTime, shortId, SOURCE_LABEL, TYPE_LABEL } from "@/lib/format";
import type { ValidationIssue } from "@/lib/validation/delivery";
import { defaultDeps } from "@/lib/workflow/core";
import { getWorkflowDetail } from "@/lib/workflow/queries";
import { currentValidation } from "@/lib/workflow/service";

export const metadata: Metadata = { title: "Workflow" };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // Ownership is enforced inside the query; someone else's workflow is a plain 404.
  const workflow = await getWorkflowDetail(getDb(), user.id, id);
  if (!workflow) notFound();

  const extracted = workflow.extracted;
  const canReview = workflow.status === "REVIEW_REQUIRED";
  const stored = workflow.validations[0];
  // While a decision is pending the page shows validation computed NOW (not the result stored at processing
  // time), so Approve never looks enabled when the server would refuse — e.g. after the delivery date has passed.
  const fresh = canReview && extracted ? await currentValidation(defaultDeps(), user.id, id) : null;
  const issues = (fresh?.issues ?? stored?.issues ?? []) as unknown as ValidationIssue[];
  const reviewEvent = [...workflow.auditEvents].reverse().find((e) => e.eventType === "REVIEW_REQUIRED");
  const reasons = ((reviewEvent?.metadata as { reasons?: string[] } | null)?.reasons ?? []).slice(0, 6);
  const working = ["RECEIVED", "PROCESSING", "EXTRACTED", "VALIDATING", "APPROVED", "EXECUTING"].includes(workflow.status);
  const job = workflow.jobs.find((j) => j.status === "QUEUED" || j.status === "RUNNING");

  return (
    <>
      <AutoRefresh active={working} />
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-sm text-slate-600">
        <Link href="/dashboard" className="hover:underline">Dashboard</Link>
        <ChevronRight aria-hidden className="size-3.5" />
        <span className="font-mono text-slate-900">{shortId(workflow.id)}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900">{workflow.customerName ?? "Unknown customer"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {TYPE_LABEL[workflow.type]} · {SOURCE_LABEL[workflow.source]} · received {formatFullDateTime(workflow.createdAt)}
            {canReview && workflow.reviewRequiredAt && <> · <span className="font-medium text-amber-800">waiting {ageLabel(workflow.reviewRequiredAt)}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ConfidenceBadge level={workflow.overallConfidence} />
          <StatusPill status={workflow.status} />
        </div>
      </header>

      {workflow.status === "FAILED" && (
        <div className="mb-6">
          <Alert tone="error" title="This workflow failed">{workflow.failureReason ?? "An error occurred."} You can retry from the panel on the right.</Alert>
        </div>
      )}
      {workflow.status === "REJECTED" && (
        <div className="mb-6"><Alert tone="info" title="Rejected">This request was rejected and no action was taken.</Alert></div>
      )}
      {workflow.status === "COMPLETED" && (
        <div className="mb-6"><Alert tone="success" title="Completed">Approved by a person and the automated action ran. See the timeline for the full history.</Alert></div>
      )}
      {working && (
        <div className="mb-6">
          <Alert tone="info" title="Working in the background">
            This workflow is {workflow.status.toLowerCase().replace("_", " ")}
            {job ? ` (attempt ${Math.max(job.attempts, 1)} of ${job.maxAttempts})` : ""}. This page refreshes automatically; you can safely leave it — the work continues on the server.
          </Alert>
        </div>
      )}
      {workflow.input?.purgedAt && (
        <div className="mb-6"><Alert tone="info" title="Content purged">The document and extracted data were erased under the retention policy. Status history and the audit trail remain.</Alert></div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {extracted ? (
            canReview ? (
              <ReviewPanel
                workflowId={workflow.id}
                version={workflow.version}
                canReview
                fields={extracted.fields as unknown as ExtractedFields}
                assessments={extracted.fieldStatus as unknown as ReviewAssessments}
                issues={issues}
                reasons={reasons}
              />
            ) : (
              <section aria-labelledby="extracted-h" className="card">
                <div className="card-header"><h2 id="extracted-h" className="card-title">Extracted information</h2></div>
                <ExtractedFieldsList
                  fields={extracted.fields as unknown as ExtractedFields}
                  assessments={extracted.fieldStatus as unknown as ReviewAssessments}
                  issues={workflow.status === "COMPLETED" || workflow.status === "REJECTED" ? [] : issues}
                />
              </section>
            )
          ) : (
            !working && <section className="card card-body text-sm text-slate-600">No data{workflow.input?.purgedAt ? " is retained" : " was extracted"}{workflow.failureReason ? `: ${workflow.failureReason}` : "."}</section>
          )}
          {extracted && <AiAnalysis data={extracted} />}
          <ValidationCard result={stored} liveIssues={fresh ? (issues as ValidationIssue[]) : undefined} />
          <SourceCard input={workflow.input} />
        </div>

        <div className="space-y-6">
          <ReviewHistory reviews={workflow.reviews} />
          <ActionsCard workflow={workflow} />
          <Timeline events={workflow.auditEvents} />
        </div>
      </div>
    </>
  );
}
