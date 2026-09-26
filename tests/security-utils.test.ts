import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeEqual } from "@/lib/crypto";
import { redact } from "@/lib/logger";
import { RateLimiter } from "@/lib/rate-limit";
import { DocumentError, inspectUpload, safeFileName } from "@/lib/documents/extract";

describe("logger redaction", () => {
  it("masks secrets, credentials, contact data and free-form document content", () => {
    const out = redact({
      apiKey: "sk-ant-123",
      password: "hunter2",
      authorization: "Bearer x",
      text: "Customer: ABC 125 King Street",
      content: "doc",
      email: "a@b.test",
      nested: { secret: "s", workflowId: "wf_1" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/sk-ant|hunter2|Bearer|125 King|a@b\.test/);
    expect((out.nested as Record<string, unknown>).workflowId).toBe("wf_1");
  });

  it("truncates long strings and keeps error messages, not stacks", () => {
    const out = redact({ note: "x".repeat(1000), error: new Error("boom") }) as { note: string; error: Record<string, unknown> };
    expect(out.note.length).toBeLessThan(300);
    expect(out.error).toEqual({ name: "Error", message: "boom" });
  });
});

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("ofs_secret");
    expect(decryptSecret(a)).toBe("ofs_secret");
    expect(encryptSecret("ofs_secret")).not.toBe(a);
  });

  it("detects tampering", () => {
    const [iv, tag, data] = encryptSecret("ofs_secret").split(".");
    const flipped = `${iv}.${tag}.${data!.slice(0, -2)}${data!.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => decryptSecret(flipped)).toThrow();
    expect(() => decryptSecret("garbage")).toThrow();
  });

  it("compares in constant time and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit within the window, then blocks, then recovers", () => {
    let t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => rl.check("k").allowed)).toEqual([true, true, true]);
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(rl.check("other").allowed).toBe(true);
    t = 1001;
    expect(rl.check("k").allowed).toBe(true);
  });
});

describe("document upload handling", () => {
  const file = (bytes: Uint8Array | string, name: string, type = "") => new File([bytes as BlobPart], name, { type });

  it("reads plain text files", async () => {
    const r = await inspectUpload(file("Customer: Acme\n2 pallets", "req.txt", "text/plain"));
    expect(r).toMatchObject({ kind: "text", mimeType: "text/plain" });
    expect((r as { text: string }).text).toContain("Customer: Acme");
  });

  it("rejects empty, oversized and binary-disguised-as-text files", async () => {
    await expect(inspectUpload(file("", "a.txt"))).rejects.toBeInstanceOf(DocumentError);
    await expect(inspectUpload(file("a".repeat(2 * 1024 * 1024 + 1), "big.txt"))).rejects.toMatchObject({ userMessage: expect.stringMatching(/too large/i) });
    await expect(inspectUpload(file(new Uint8Array([0x41, 0x00, 0x42]), "bin.txt"))).rejects.toBeInstanceOf(DocumentError);
  });

  it("decides by content, not by claimed name or MIME type", async () => {
    await expect(inspectUpload(file(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]), "invoice.txt", "text/plain"))).rejects.toBeInstanceOf(DocumentError);
    const html = await inspectUpload(file("<script>alert(1)</script>", "evil.exe", "application/x-msdownload"));
    expect(html.mimeType).toBe("text/plain"); // stored and rendered as inert text, never as HTML
    await expect(inspectUpload(file("not really a pdf", "fake.pdf", "application/pdf"))).rejects.toMatchObject({ userMessage: expect.stringMatching(/valid PDF/i) });
  });

  it("sanitises client-supplied file names", async () => {
    const r = await inspectUpload(file("hello", "../../etc/pass<wd>|?.txt"));
    expect(r.fileName).toBe("passwd.txt"); // path components and unsafe characters are stripped
    expect(safeFileName("C:\\Users\\x\\evil.txt")).toBe("evil.txt");
    expect(safeFileName("\u0000\u001f")).toBe("upload");
  });

  it("recognises images and reports that OCR is not enabled (architecture placeholder)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(inspectUpload(file(png, "scan.png", "image/png"))).rejects.toMatchObject({ userMessage: expect.stringMatching(/OCR/) });
  });
});
