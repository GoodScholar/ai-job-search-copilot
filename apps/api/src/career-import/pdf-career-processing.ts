import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import {
  isPdfPageCountWithinBudget,
  isPdfPageTextWithinBudget,
  serializePdfPageText,
} from "@job-copilot/contracts/pdf-career-processing";

const PDF_SUBPROCESS_MAX_OLD_SPACE_MB = 64;
const PDF_SUBPROCESS_TIMEOUT_MS = 3_000;
const PDF_SUBPROCESS_MAX_STDOUT_BYTES = 524_288;
export const PDF_SUBPROCESS_MAX_ACTIVE = 2;
export const PDF_SUBPROCESS_MAX_QUEUED = 8;
const runtimeRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const resolveModuleUrl = (specifier: string) => pathToFileURL(runtimeRequire.resolve(specifier)).href;
const pdfJsModuleUrl = resolveModuleUrl("pdfjs-dist/legacy/build/pdf.mjs");
const contractsPdfProcessingUrl = resolveModuleUrl("@job-copilot/contracts/pdf-career-processing");

type PdfChildCode = "INVALID_PDF" | "ENCRYPTED_PDF" | "NO_TEXT" | "TOO_COMPLEX";
type PdfChildResponse = { ok: true; pages: string[] } | { ok: false; code: PdfChildCode };
type SpawnProcess = typeof spawn;
type ProcessorUnavailableReason = "QUEUE_FULL" | "SPAWN_FAILED" | "CHILD_ERROR" | "CHILD_EXITED" | "INVALID_PROTOCOL";

// This child owns only PDF.js and the supplied PDF bytes. It has no application dependencies,
// network handles, database connection, object-store credentials, or inherited environment.
const pdfChildScript = String.raw`
import {
  isPdfPageCountWithinBudget,
  isPdfPageTextWithinBudget,
  isPdfTextByteCountWithinBudget,
  isPdfTextItemCountWithinBudget,
  pdfTextUtf8Bytes,
  reconstructPdfPageLines,
} from ${JSON.stringify(contractsPdfProcessingUrl)};

const maxOutputBytes = ${PDF_SUBPROCESS_MAX_STDOUT_BYTES};
const send = (response) => process.stdout.write(JSON.stringify(response));
const fail = (code) => send({ ok: false, code });

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  let loadingTask;
  let pdfjs;
  try {
    pdfjs = await import(${JSON.stringify(pdfJsModuleUrl)});
  } catch {
    // A missing/broken PDF.js runtime is processor infrastructure, not a document error.
    process.exitCode = 1;
    return;
  }
  try {
    const bytes = await readInput();
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    let document;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      fail(error && typeof error === "object" && error.name === "PasswordException" ? "ENCRYPTED_PDF" : "INVALID_PDF");
      return;
    }
    if (!isPdfPageCountWithinBudget(document.numPages)) {
      fail("TOO_COMPLEX");
      return;
    }
    const pages = [];
    let itemCount = 0;
    let textByteCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      itemCount += content.items.length;
      if (!isPdfTextItemCountWithinBudget(itemCount)) {
        fail("TOO_COMPLEX");
        return;
      }
      const items = content.items.map((item) => (
        typeof item === "object" && item !== null && "str" in item ? item : {}
      ));
      for (const item of items) {
        textByteCount += pdfTextUtf8Bytes(item.str || "");
        if (!isPdfTextByteCountWithinBudget(textByteCount)) {
          fail("TOO_COMPLEX");
          return;
        }
      }
      pages.push(reconstructPdfPageLines(items));
      if (!isPdfPageTextWithinBudget(pages)) {
        fail("TOO_COMPLEX");
        return;
      }
    }
    const response = JSON.stringify({ ok: true, pages });
    if (Buffer.byteLength(response) > maxOutputBytes) {
      fail("TOO_COMPLEX");
      return;
    }
    process.stdout.write(response);
  } catch {
    fail("INVALID_PDF");
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}

void main();
`;

export class PdfCareerDocumentError extends Error {
  constructor(public readonly code: "CAREER_DOCUMENT_INVALID_PDF" | "CAREER_DOCUMENT_ENCRYPTED_PDF" | "CAREER_DOCUMENT_PDF_NO_TEXT" | "CAREER_DOCUMENT_PDF_TOO_COMPLEX") {
    super(code);
  }
}

export class PdfCareerProcessorUnavailableError extends Error {
  readonly code = "CAREER_IMPORT_UNAVAILABLE";
  constructor(public readonly reason: ProcessorUnavailableReason) {
    super(reason);
  }
}

export class PdfSubprocessPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxActive = PDF_SUBPROCESS_MAX_ACTIVE,
    private readonly maxQueued = PDF_SUBPROCESS_MAX_QUEUED,
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new PdfCareerProcessorUnavailableError("QUEUE_FULL"));
    }
    return new Promise((resolve) => this.waiters.push(() => resolve(this.createRelease())));
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

const pdfSubprocessPool = new PdfSubprocessPool();

export type PdfSubprocessOptions = {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  spawnProcess?: SpawnProcess;
  pool?: PdfSubprocessPool;
};

function asDocumentError(code: PdfChildCode): PdfCareerDocumentError {
  return new PdfCareerDocumentError(code === "ENCRYPTED_PDF" ? "CAREER_DOCUMENT_ENCRYPTED_PDF"
    : code === "NO_TEXT" ? "CAREER_DOCUMENT_PDF_NO_TEXT"
      : code === "TOO_COMPLEX" ? "CAREER_DOCUMENT_PDF_TOO_COMPLEX"
        : "CAREER_DOCUMENT_INVALID_PDF");
}

function isChildResponse(value: unknown): value is PdfChildResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "pages" in value && Array.isArray(value.pages) && value.pages.every((page) => typeof page === "string");
  return value.ok === false && "code" in value && typeof value.code === "string"
    && ["INVALID_PDF", "ENCRYPTED_PDF", "NO_TEXT", "TOO_COMPLEX"].includes(value.code);
}

function runPdfSubprocess(bytes: Uint8Array, options: PdfSubprocessOptions): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? PDF_SUBPROCESS_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? PDF_SUBPROCESS_MAX_STDOUT_BYTES;
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise<string[]>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let finished = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    const finish = (
      error?: PdfCareerDocumentError | PdfCareerProcessorUnavailableError,
      pages?: string[],
      terminate = false,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (terminate) {
        try { child?.kill("SIGKILL"); } catch { /* already exited */ }
      }
      if (error) reject(error);
      else resolve(pages!);
    };
    const timeout = setTimeout(() => finish(new PdfCareerDocumentError("CAREER_DOCUMENT_PDF_TOO_COMPLEX"), undefined, true), timeoutMs);
    try {
      child = spawnProcess(process.execPath, [
        `--max-old-space-size=${PDF_SUBPROCESS_MAX_OLD_SPACE_MB}`,
        "--input-type=module",
        "--eval",
        pdfChildScript,
      ], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish(new PdfCareerProcessorUnavailableError("SPAWN_FAILED"));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        finish(new PdfCareerDocumentError("CAREER_DOCUMENT_PDF_TOO_COMPLEX"), undefined, true);
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.once("error", () => finish(new PdfCareerProcessorUnavailableError("CHILD_ERROR")));
    child.once("close", (exitCode) => {
      if (finished) return;
      if (exitCode !== 0) {
        finish(new PdfCareerProcessorUnavailableError("CHILD_EXITED"));
        return;
      }
      let response: unknown;
      try { response = JSON.parse(Buffer.concat(stdout).toString("utf8")); } catch {
        finish(new PdfCareerProcessorUnavailableError("INVALID_PROTOCOL"));
        return;
      }
      if (!isChildResponse(response)) {
        finish(new PdfCareerProcessorUnavailableError("INVALID_PROTOCOL"));
        return;
      }
      if (!response.ok) {
        finish(asDocumentError(response.code));
        return;
      }
      if (!isPdfPageCountWithinBudget(response.pages.length) || !isPdfPageTextWithinBudget(response.pages)) {
        finish(new PdfCareerDocumentError("CAREER_DOCUMENT_PDF_TOO_COMPLEX"));
        return;
      }
      finish(undefined, response.pages);
    });
    child.stdin?.once("error", () => finish(new PdfCareerProcessorUnavailableError("CHILD_ERROR")));
    child.stdin?.end(Buffer.from(bytes));
  });
}

/** Lower-level seam for deterministic pool, timeout, and stdout-budget tests. */
export async function extractPdfPagesInSubprocess(
  bytes: Uint8Array,
  options: PdfSubprocessOptions = {},
): Promise<string[]> {
  const release = await (options.pool ?? pdfSubprocessPool).acquire();
  try {
    return await runPdfSubprocess(bytes, options);
  } finally {
    release();
  }
}

export async function extractCanonicalPdfPageText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > CAREER_DOCUMENT_MAX_BYTES) throw new PdfCareerDocumentError("CAREER_DOCUMENT_INVALID_PDF");
  const pages = await extractPdfPagesInSubprocess(bytes);
  if (!pages.some((page) => page.trim().length > 0)) throw new PdfCareerDocumentError("CAREER_DOCUMENT_PDF_NO_TEXT");
  return serializePdfPageText(pages);
}
