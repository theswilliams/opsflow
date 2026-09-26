import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/**
 * PDF text extraction in an isolated worker thread with a hard wall-clock timeout and a memory cap.
 * A crafted PDF can spin a CPU forever inside pdf.js; running it on the request thread would freeze
 * every request. Here the worst case is a terminated worker and a clean, user-facing failure.
 */
export class PdfError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "TOO_MANY_PAGES" | "INVALID" | "BUSY",
    readonly userMessage: string,
  ) {
    super(`${code}: ${userMessage}`);
    this.name = "PdfError";
  }
}

export interface PdfOptions {
  timeoutMs?: number;
  maxPages?: number;
  maxMemoryMb?: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { extractText, getDocumentProxy } = await import(workerData.unpdfUrl);
    const pdf = await getDocumentProxy(new Uint8Array(workerData.bytes));
    if (pdf.numPages > workerData.maxPages) { parentPort.postMessage({ ok: false, code: 'TOO_MANY_PAGES' }); return; }
    const { text } = await extractText(pdf, { mergePages: true });
    parentPort.postMessage({ ok: true, text: Array.isArray(text) ? text.join('\\n') : text });
  } catch (e) {
    parentPort.postMessage({ ok: false, code: 'INVALID' });
  }
})();
`;

let unpdfUrl: string | undefined;
function resolveUnpdf(): string {
  // Resolved from the project root so it works under Next.js bundling, tsx and vitest alike.
  unpdfUrl ??= pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve("unpdf")).href;
  return unpdfUrl;
}

/** At most this many parses at once, so a burst of uploads cannot exhaust CPU/RAM. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

export async function extractPdfText(bytes: Uint8Array, options: PdfOptions = {}): Promise<string> {
  const { timeoutMs = 10_000, maxPages = 25, maxMemoryMb = 256 } = options;
  await acquire();
  try {
    return await new Promise<string>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { bytes: Buffer.from(bytes), maxPages, unpdfUrl: resolveUnpdf() },
        resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb, maxYoungGenerationSizeMb: 32 },
      });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new PdfError("TIMEOUT", "The PDF took too long to read and was stopped."))), timeoutMs);
      worker.once("message", (m: { ok: boolean; text?: string; code?: string }) =>
        finish(() => {
          if (m.ok) return resolve(m.text ?? "");
          if (m.code === "TOO_MANY_PAGES") return reject(new PdfError("TOO_MANY_PAGES", `PDF has too many pages (limit ${maxPages}).`));
          reject(new PdfError("INVALID", "That file is not a valid PDF."));
        }),
      );
      // Out-of-memory or crash inside the worker: contained, reported as an invalid document.
      worker.once("error", () => finish(() => reject(new PdfError("INVALID", "That file could not be read as a PDF."))));
      worker.once("exit", (code) => finish(() => reject(new PdfError("INVALID", code === 0 ? "That file is not a valid PDF." : "That file could not be read as a PDF."))));
    });
  } finally {
    release();
  }
}
