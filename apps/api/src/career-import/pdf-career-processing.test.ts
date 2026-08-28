import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PdfSubprocessOptions } from "./pdf-career-processing.js";
import { extractPdfPagesInSubprocess, PdfSubprocessPool } from "./pdf-career-processing.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("PDF 子进程提取", () => {
  it("全局池只启动两个子进程，并在释放一个 slot 后启动排队请求", async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const spawn = vi.fn(() => children[spawn.mock.calls.length - 1]!);
    const pool = new PdfSubprocessPool(2, 8);
    const options = { pool, spawnProcess: spawn as unknown as PdfSubprocessOptions["spawnProcess"] };
    const first = extractPdfPagesInSubprocess(new Uint8Array([1]), options);
    const second = extractPdfPagesInSubprocess(new Uint8Array([2]), options);
    const third = extractPdfPagesInSubprocess(new Uint8Array([3]), options);

    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(2);

    children[0]!.stdout.write(JSON.stringify({ ok: true, pages: ["first"] }));
    children[0]!.emit("close", 0);
    await first;
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(3);

    children[1]!.stdout.write(JSON.stringify({ ok: true, pages: ["second"] }));
    children[1]!.emit("close", 0);
    children[2]!.stdout.write(JSON.stringify({ ok: true, pages: ["third"] }));
    children[2]!.emit("close", 0);
    await expect(Promise.all([second, third])).resolves.toEqual([["second"], ["third"]]);
  });

  it("在八个等待请求后稳定削峰", async () => {
    const pool = new PdfSubprocessPool(2, 8);
    await pool.acquire();
    await pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();
    void pool.acquire();

    await expect(pool.acquire()).rejects.toMatchObject({ code: "CAREER_IMPORT_UNAVAILABLE", reason: "QUEUE_FULL" });
  });

  it("在 stdout 超出 IPC 预算时终止子进程并稳定失败", async () => {
    const child = fakeChild();
    const spawn = vi.fn((..._args: unknown[]) => child);
    const spawnProcess = spawn as unknown as PdfSubprocessOptions["spawnProcess"];
    const extraction = extractPdfPagesInSubprocess(new Uint8Array([1]), { maxStdoutBytes: 1, spawnProcess });

    child.stdout.write('{"ok":true,"pages":["text"]}');

    await expect(extraction).rejects.toMatchObject({ code: "CAREER_DOCUMENT_PDF_TOO_COMPLEX" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ env: {} });
  });

  it("在硬超时后终止子进程并稳定失败", async () => {
    const child = fakeChild();
    const spawnProcess = (() => child) as unknown as PdfSubprocessOptions["spawnProcess"];

    await expect(extractPdfPagesInSubprocess(new Uint8Array([1]), { timeoutMs: 1, spawnProcess }))
      .rejects.toMatchObject({ code: "CAREER_DOCUMENT_PDF_TOO_COMPLEX" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("将未知的非零退出视为处理器不可用", async () => {
    const child = fakeChild();
    const spawnProcess = (() => child) as unknown as PdfSubprocessOptions["spawnProcess"];
    const extraction = extractPdfPagesInSubprocess(new Uint8Array([1]), { spawnProcess });

    await Promise.resolve();
    child.emit("close", 137);

    await expect(extraction).rejects.toMatchObject({ code: "CAREER_IMPORT_UNAVAILABLE", reason: "CHILD_EXITED" });
  });

  it("将同步 spawn 失败视为处理器不可用", async () => {
    const spawnProcess = (() => { throw new Error("bootstrap failed"); }) as unknown as PdfSubprocessOptions["spawnProcess"];

    await expect(extractPdfPagesInSubprocess(new Uint8Array([1]), { spawnProcess }))
      .rejects.toMatchObject({ code: "CAREER_IMPORT_UNAVAILABLE", reason: "SPAWN_FAILED" });
  });

  it("将无效子进程协议视为处理器不可用", async () => {
    const child = fakeChild();
    const spawnProcess = (() => child) as unknown as PdfSubprocessOptions["spawnProcess"];
    const extraction = extractPdfPagesInSubprocess(new Uint8Array([1]), { spawnProcess });

    await Promise.resolve();
    child.stdout.write("not-json");
    child.emit("close", 0);

    await expect(extraction).rejects.toMatchObject({ code: "CAREER_IMPORT_UNAVAILABLE", reason: "INVALID_PROTOCOL" });
  });

  it("将超出共享页数预算的成功响应视为文档复杂度", async () => {
    const child = fakeChild();
    const spawnProcess = (() => child) as unknown as PdfSubprocessOptions["spawnProcess"];
    const extraction = extractPdfPagesInSubprocess(new Uint8Array([1]), { spawnProcess });

    await Promise.resolve();
    child.stdout.write(JSON.stringify({ ok: true, pages: Array.from({ length: 51 }, () => "") }));
    child.emit("close", 0);

    await expect(extraction).rejects.toMatchObject({ code: "CAREER_DOCUMENT_PDF_TOO_COMPLEX" });
  });
});
