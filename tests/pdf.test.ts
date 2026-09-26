/**
 * F11 — PDF parsing must never run unbounded on the request thread.
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { DocumentError, inspectUpload, MAX_UPLOAD_BYTES, parsePdfBytes } from "@/lib/documents/extract";
import { extractPdfText, PdfError } from "@/lib/documents/pdf-worker";
import { drainJobs } from "@/lib/jobs/worker";
import { actorOf, makeUser, testDeps } from "./helpers";
import { createWorkflow, submitWorkflow } from "@/lib/workflow/service";

const db = getDb();
const enc = (s: string) => new TextEncoder().encode(s);

/** Builds a small, valid PDF with `pages` pages, each containing the given text lines. */
function buildPdf(pages: number, lines: string[] = ["Customer: Acme Supply", "2 pallets of brick to 10 Main Street, Toronto, Ontario on 2026-10-06 at 9am. Call Sam 519-555-0100."]) {
  const objs: string[] = [];
  const kids: string[] = [];
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push(""); // pages placeholder
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"); // obj 3 = font
  for (let p = 0; p < pages; p++) {
    const pageObj = 4 + p * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l.replace(/[()\\]/g, "")}) Tj`).join(" ")} ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentObj} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`);
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<</Type/Pages/Kids[${kids.join(" ")}]/Count ${pages}>>`;
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join("\n");
  return enc(`%PDF-1.4\n${body}\ntrailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\n%%EOF`);
}

/** A page with a very large amount of text operators: slow to parse. */
const heavyPdf = () => buildPdf(25, Array.from({ length: 3_000 }, (_, i) => `Line ${i} lorem ipsum dolor sit amet consectetur`));

describe("F11 · PDF parsing is isolated, bounded and reported cleanly", () => {
  it("extracts text from a valid PDF (in a worker thread)", async () => {
    const text = await parsePdfBytes(buildPdf(1));
    expect(text).toContain("Customer: Acme Supply");
    expect(text).toContain("519-555-0100");
  });

  it("malformed PDFs fail with a clean user-facing error, not a crash", async () => {
    for (const bytes of [enc("%PDF-1.4\ngarbage that is not a pdf"), enc("%PDF-"), new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 255, 255])]) {
      await expect(parsePdfBytes(bytes)).rejects.toMatchObject({ userMessage: expect.stringMatching(/valid PDF|could not be read/i) });
      await expect(parsePdfBytes(bytes)).rejects.toBeInstanceOf(DocumentError);
    }
  });

  it("enforces the page limit (25) inside the worker", async () => {
    await expect(parsePdfBytes(buildPdf(26))).rejects.toMatchObject({ userMessage: expect.stringMatching(/too many pages \(limit 25\)/) });
    expect(await parsePdfBytes(buildPdf(25))).toContain("Acme");
  });

  it("rejects oversized uploads before any parsing", async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf");
    await expect(inspectUpload(big)).rejects.toMatchObject({ userMessage: expect.stringMatching(/too large/i) });
    const empty = new File([], "empty.pdf");
    await expect(inspectUpload(empty)).rejects.toBeInstanceOf(DocumentError);
  });

  it("the request path does only cheap checks: a PDF upload is inspected but NOT parsed", async () => {
    const started = performance.now();
    const doc = await inspectUpload(new File([buildPdf(1)], "order.pdf", { type: "application/pdf" }));
    expect(doc.kind).toBe("pdf");
    expect("text" in doc).toBe(false); // no text extracted on the request thread
    expect(performance.now() - started).toBeLessThan(200);
    const notPdf = new File([enc("not really a pdf")], "fake.pdf");
    await expect(inspectUpload(notPdf)).rejects.toMatchObject({ userMessage: expect.stringMatching(/valid PDF/i) });
  });

  it("a parser TIMEOUT terminates the worker and the main thread stays responsive throughout", async () => {
    // Responsiveness is judged by the longest gap between event-loop ticks, not by how many ticks fit in the
    // window: a tick count shrinks on a loaded machine (a false failure), whereas a parse running on the main
    // thread would show up as one long gap.
    let beats = 0;
    let last = performance.now();
    let maxGap = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      beats++;
    }, 5);
    const started = performance.now();
    await expect(extractPdfText(heavyPdf(), { timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const elapsed = performance.now() - started;
    clearInterval(heartbeat);
    expect(elapsed).toBeLessThan(5_000); // stopped near the deadline, not after the whole parse (which takes far longer)
    expect(beats).toBeGreaterThan(0);
    expect(maxGap).toBeLessThan(500); // the event loop was never blocked for long while the PDF was being "parsed"
  });

  it("timeouts surface to the user as a document error", async () => {
    await expect(parsePdfBytes(heavyPdf(), { timeoutMs: 30 })).rejects.toMatchObject({ userMessage: expect.stringMatching(/too long to read/) });
  });

  it("repeated processing is stable (no leaked workers or state)", async () => {
    for (let i = 0; i < 6; i++) expect(await parsePdfBytes(buildPdf(1))).toContain("Acme");
    await expect(parsePdfBytes(enc("%PDF-1.4\nnope"))).rejects.toBeInstanceOf(DocumentError);
    expect(await parsePdfBytes(buildPdf(2))).toContain("Acme"); // still healthy after a failure
  });

  it("concurrent uploads are all served (a bounded pool, not a stampede)", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => parsePdfBytes(buildPdf(2))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // A mix of good and bad in parallel: failures stay isolated to their own request.
    const mixed = await Promise.allSettled([parsePdfBytes(buildPdf(1)), parsePdfBytes(enc("%PDF-1.4\nbad")), parsePdfBytes(buildPdf(1))]);
    expect(mixed.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("PdfError carries a stable machine-readable code", async () => {
    await expect(extractPdfText(enc("%PDF-1.4\nbad"))).rejects.toBeInstanceOf(PdfError);
  });
});

describe("F11 · PDF upload as a durable job", () => {
  it("the uploaded bytes are parsed in the background job, then discarded", async () => {
    const user = await makeUser("f11a");
    const created = await createWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "UPLOAD", kind: "document", text: "", rawBytes: buildPdf(1), fileName: "order.pdf", mimeType: "application/pdf", sizeBytes: 900 });
    let input = await db.workflowInput.findUniqueOrThrow({ where: { workflowId: created.id } });
    expect(input.rawBytes).not.toBeNull();
    expect(input.content).toBe(""); // nothing parsed on the request path
    expect((await db.workflow.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("RECEIVED");

    await drainJobs(testDeps());
    const w = await db.workflow.findUniqueOrThrow({ where: { id: created.id }, include: { extracted: true } });
    expect(w.status).toBe("REVIEW_REQUIRED");
    expect(w.customerName).toBe("Acme Supply");
    input = await db.workflowInput.findUniqueOrThrow({ where: { workflowId: created.id } });
    expect(input.rawBytes).toBeNull(); // raw upload not retained
    expect(input.content).toContain("Customer: Acme Supply");
  });

  it("a malformed or too-long PDF ends as a clear FAILED workflow (no retry storm) and keeps no bytes", async () => {
    const user = await makeUser("f11b");
    const bad = await submitWorkflow(testDeps(), { userId: user.id, actor: actorOf(user.id), source: "UPLOAD", kind: "document", text: "", rawBytes: enc("%PDF-1.4\ngarbage"), fileName: "bad.pdf", mimeType: "application/pdf", sizeBytes: 20 });
    const w = await db.workflow.findUniqueOrThrow({ where: { id: bad.id } });
    expect(w).toMatchObject({ status: "FAILED", needsAttention: true });
    expect(w.failureReason).toMatch(/valid PDF|could not be read/);
    expect((await db.workflowInput.findUniqueOrThrow({ where: { workflowId: bad.id } })).rawBytes).toBeNull();
    expect((await db.job.findFirstOrThrow({ where: { workflowId: bad.id } })).attempts).toBe(1);

    const slow = await submitWorkflow(testDeps({ pdf: { timeoutMs: 30 } }), { userId: user.id, actor: actorOf(user.id), source: "UPLOAD", kind: "document", text: "", rawBytes: heavyPdf(), fileName: "slow.pdf", mimeType: "application/pdf", sizeBytes: 5_000 });
    expect((await db.workflow.findUniqueOrThrow({ where: { id: slow.id } })).failureReason).toMatch(/too long to read/);
  });
});
