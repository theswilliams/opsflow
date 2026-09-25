import { MAX_INPUT_CHARS } from "@/lib/ai/extract";

/**
 * Document → plain text. The file's declared name/MIME type are never trusted:
 * the format is decided from the leading bytes.
 *
 * Extension point: to add OCR, implement a new branch (or `TextExtractor`) for images
 * that returns text, and keep everything downstream unchanged.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 25;

export class DocumentError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "DocumentError";
  }
}

export interface ExtractedDocument {
  kind: "document";
  text: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

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

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch {
    throw new DocumentError("That file is not a valid PDF.");
  }
  if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentError(`PDF has too many pages (limit ${MAX_PDF_PAGES}).`);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  if (file.size === 0) throw new DocumentError("The file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentError(`File is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let text: string;
  let mimeType: string;
  if (isPdf(bytes)) {
    mimeType = "application/pdf";
    text = await pdfToText(bytes);
  } else if (isImage(bytes)) {
    throw new DocumentError("Image documents need OCR, which is not enabled in this build. Upload a text file or PDF, or paste the text.");
  } else if (bytes.includes(0)) {
    throw new DocumentError("Unsupported file type. Upload a .txt or .pdf file, or paste the text.");
  } else if (/\.pdf$/i.test(file.name)) {
    throw new DocumentError("That file is not a valid PDF.");
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DocumentError("Unsupported file type. Upload a .txt or .pdf file, or paste the text.");
    }
    mimeType = "text/plain";
  }

  text = text.trim();
  if (!text) throw new DocumentError("No readable text was found in the file.");
  if (text.length > MAX_INPUT_CHARS) throw new DocumentError(`The document is too long (limit ${MAX_INPUT_CHARS.toLocaleString("en-CA")} characters).`);
  return { kind: "document", text, fileName: safeFileName(file.name), mimeType, sizeBytes: file.size };
}
