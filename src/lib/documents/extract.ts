import { MAX_INPUT_CHARS } from "@/lib/ai/extract";
import { extractPdfText, PdfError, type PdfOptions } from "./pdf-worker";

/**
 * Document → plain text. The file's declared name/MIME type are never trusted:
 * the format is decided from the leading bytes.
 *
 * Two phases keep the request path cheap:
 *  - `inspectUpload` (request time): size, magic bytes, UTF-8 text decoding. No heavy parsing.
 *  - `parsePdfBytes` (background job): PDF parsing in an isolated worker thread with a timeout.
 *
 * Extension point: to add OCR, add a branch for images that returns text via a job, and keep
 * everything downstream unchanged.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_PAGES = 25;

export class DocumentError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "DocumentError";
  }
}

export type InspectedUpload =
  | { kind: "text"; text: string; fileName: string; mimeType: "text/plain"; sizeBytes: number }
  | { kind: "pdf"; bytes: Uint8Array; fileName: string; mimeType: "application/pdf"; sizeBytes: number };

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const isPdf = (b: Uint8Array) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const isImage = (b: Uint8Array) =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || // PNG
  startsWith(b, [0xff, 0xd8, 0xff]) || // JPEG
  startsWith(b, [0x47, 0x49, 0x46, 0x38]) || // GIF
  (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && b[8] === 0x57 && b[9] === 0x45); // WEBP

/** Strips path components and control characters from a client-supplied file name. */
export function safeFileName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? "upload").replace(/[\u0000-\u001F<>:"|?*]/g, "").slice(0, 120) || "upload";
}

export async function inspectUpload(file: File): Promise<InspectedUpload> {
  if (file.size === 0) throw new DocumentError("The file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentError(`File is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileName = safeFileName(file.name);

  if (isPdf(bytes)) return { kind: "pdf", bytes, fileName, mimeType: "application/pdf", sizeBytes: file.size };
  if (isImage(bytes)) {
    throw new DocumentError("Image documents need OCR, which is not enabled in this build. Upload a text file or PDF, or paste the text.");
  }
  if (bytes.includes(0)) throw new DocumentError("Unsupported file type. Upload a .txt or .pdf file, or paste the text.");
  if (/\.pdf$/i.test(file.name)) throw new DocumentError("That file is not a valid PDF.");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new DocumentError("Unsupported file type. Upload a .txt or .pdf file, or paste the text.");
  }
  if (!text) throw new DocumentError("No readable text was found in the file.");
  if (text.length > MAX_INPUT_CHARS) throw new DocumentError(`The document is too long (limit ${MAX_INPUT_CHARS.toLocaleString("en-CA")} characters).`);
  return { kind: "text", text, fileName, mimeType: "text/plain", sizeBytes: file.size };
}

/** Background-job step: PDF bytes → text, in an isolated worker with a timeout. */
export async function parsePdfBytes(bytes: Uint8Array, options: PdfOptions = {}): Promise<string> {
  let text: string;
  try {
    text = (await extractPdfText(bytes, { maxPages: MAX_PDF_PAGES, ...options })).trim();
  } catch (err) {
    if (err instanceof PdfError) throw new DocumentError(err.userMessage);
    throw new DocumentError("That file could not be read as a PDF.");
  }
  if (!text) throw new DocumentError("No readable text was found in the file.");
  if (text.length > MAX_INPUT_CHARS) throw new DocumentError(`The document is too long (limit ${MAX_INPUT_CHARS.toLocaleString("en-CA")} characters).`);
  return text;
}
