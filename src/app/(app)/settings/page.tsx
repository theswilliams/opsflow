import type { Metadata } from "next";
import { revokeCredentialAction } from "@/app/actions/credentials";
import { CredentialForm } from "@/components/credential-form";
import { DeleteAccountForm } from "@/components/delete-account-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { isDemoMode } from "@/lib/ai";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatFullDateTime } from "@/lib/format";
import { listCredentials } from "@/lib/webhook/credentials";

export const metadata: Metadata = { title: "Integrations" };

/** Revoked credentials stay in the database for the audit trail; the page only lists the most recent few. */
const MAX_REVOKED_SHOWN = 3;

export default async function SettingsPage() {
  const user = await requireUser();
  const env = getEnv();
  const allCredentials = await listCredentials(getDb(), user.id);
  const active = allCredentials.filter((c) => !c.revokedAt);
  const revoked = allCredentials.filter((c) => c.revokedAt);
  const credentials = [...active, ...revoked.slice(0, MAX_REVOKED_SHOWN)];
  const hiddenRevoked = revoked.length - Math.min(revoked.length, MAX_REVOKED_SHOWN);
  const demo = isDemoMode();

  return (
    <>
      <PageHeader title="Integrations" description="Connect n8n or any system that can send a signed HTTP request." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section aria-labelledby="cred-h" className="card">
            <div className="card-header"><h2 id="cred-h" className="card-title">Webhook credentials</h2></div>
            <div className="card-body"><CredentialForm /></div>
            {credentials.length === 0 ? (
              <div className="border-t border-line"><EmptyState title="No credentials yet">Create one to start sending requests to the webhook.</EmptyState></div>
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {credentials.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{c.label} {c.revokedAt && <span className="pill ml-1 border-slate-300 bg-slate-100 text-slate-600">Revoked</span>}</p>
                      <p className="break-all font-mono text-xs text-slate-600">{c.keyId}</p>
                      <p className="text-xs text-slate-500">
                        Created {formatFullDateTime(c.createdAt)} · {c.lastUsedAt ? `last used ${formatFullDateTime(c.lastUsedAt)}` : "never used"}
                      </p>
                    </div>
                    {!c.revokedAt && (
                      <form action={revokeCredentialAction.bind(null, c.id)}>
                        <button type="submit" className="btn btn-danger">Revoke</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {hiddenRevoked > 0 && (
              <p className="border-t border-line px-4 py-2 text-xs text-slate-500 sm:px-5">
                {hiddenRevoked} older revoked credential{hiddenRevoked === 1 ? "" : "s"} not shown.
              </p>
            )}
          </section>

          <section aria-labelledby="ex-h" className="card">
            <div className="card-header"><h2 id="ex-h" className="card-title">Example request</h2></div>
            <div className="card-body space-y-3 text-sm text-slate-700">
              <p>Sign <code className="font-mono text-xs">{"v1 ⏎ <timestamp> ⏎ <idempotency-key> ⏎ <raw body>"}</code> with HMAC-SHA256 using your secret. The idempotency key is optional and empty here; if you send an <code className="font-mono text-xs">Idempotency-Key</code> header it must be part of what you sign.</p>
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">{`BODY='{"type":"delivery_request","text":"Customer: ABC\\n4 pallets of shingles to 125 King Street, London, Ontario this Friday","external_id":"order-1042"}'
TS=$(date +%s)
SIG=$(printf 'v1\\n%s\\n\\n%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$OPSFLOW_SECRET" | sed 's/^.* //')

curl -X POST ${env.APP_URL}/api/webhooks/workflow \\
  -H "Content-Type: application/json" \\
  -H "X-OpsFlow-Key-Id: $OPSFLOW_KEY_ID" \\
  -H "X-OpsFlow-Timestamp: $TS" \\
  -H "X-OpsFlow-Signature: sha256=$SIG" \\
  -d "$BODY"`}</pre>
              <p>See <code className="font-mono text-xs">docs/N8N.md</code> for the importable n8n workflow, error codes and polling for the review outcome.</p>
            </div>
          </section>
        </div>

        <div className="space-y-6 self-start">
        <section aria-labelledby="data-h" className="card">
          <div className="card-header"><h2 id="data-h" className="card-title">Your data</h2></div>
          <div className="card-body space-y-3 text-sm text-slate-700">
            <p>
              OpsFlow keeps the documents you submit, the data extracted from them, your review decisions and an audit trail.
              {env.RETENTION_DAYS > 0 ? ` Documents and extracted data are erased ${env.RETENTION_DAYS} days after a request is completed, rejected or failed.` : " Automatic purging is currently disabled."}{" "}
              Audit events are retained. See <code className="font-mono text-xs">docs/DATA.md</code>.
            </p>
            <a href="/api/account/export" className="btn btn-secondary">Download my data (JSON)</a>
            <DeleteAccountForm />
          </div>
        </section>

        <section aria-labelledby="env-h" className="card">
          <div className="card-header"><h2 id="env-h" className="card-title">Runtime</h2></div>
          <dl className="divide-y divide-line text-sm">
            <div className="px-4 py-3 sm:px-5">
              <dt className="text-xs font-medium text-slate-500">AI provider</dt>
              <dd className="mt-0.5 text-slate-900">{demo ? "Mock (deterministic demo provider)" : `Claude · ${env.ANTHROPIC_MODEL}`}</dd>
            </div>
            <div className="px-4 py-3 sm:px-5">
              <dt className="text-xs font-medium text-slate-500">Automated action</dt>
              <dd className="mt-0.5 text-slate-900">Simulated — confirmations are generated and recorded, never sent</dd>
            </div>
            <div className="px-4 py-3 sm:px-5">
              <dt className="text-xs font-medium text-slate-500">Business timezone</dt>
              <dd className="mt-0.5 text-slate-900">{env.BUSINESS_TIMEZONE}</dd>
            </div>
          </dl>
        </section>
        </div>
      </div>
    </>
  );
}
