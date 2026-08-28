"use client";

import { JobImportDetailSchema, type JobImportDetail, type JobImportList, type JobImportStatus } from "@job-copilot/contracts/job-imports";
import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { createJobImportAction, type JobImportActionState } from "@/app/(workbench)/jobs/import/actions";

type JobImportSummary = JobImportList["imports"][number];
type JobImportViewProps = { initialImports: JobImportSummary[] };
type InputMode = "paste" | "upload" | "url";
type RawEvidenceState =
  | { status: "idle" }
  | { status: "loading"; revision: number }
  | { status: "ready"; revision: number; content: string }
  | { status: "error"; revision: number };

const initialActionState: JobImportActionState = { ok: false, code: "", message: "" };
const terminalStatuses = new Set<JobImportStatus>(["completed", "failed"]);
const inputModes: InputMode[] = ["paste", "upload", "url"];
const statusText: Record<JobImportStatus, string> = { imported: "已导入", normalizing: "规范化中", completed: "导入完成", failed: "导入失败" };
const failureText: Record<string, string> = {
  JOB_IMPORT_CONTENT_INVALID: "岗位描述不能为空且不能超过 512 KiB。",
  JOB_IMPORT_OBJECT_STORAGE_FAILED: "岗位正文暂时无法读取，请稍后重试。",
  JOB_IMPORT_QUEUE_UNAVAILABLE: "岗位导入任务暂时不可用，请稍后重试。",
  JOB_IMPORT_CONTENT_READ_FAILED: "岗位正文暂时无法读取，请稍后重试。",
  JOB_IMPORT_CHECKSUM_MISMATCH: "岗位正文校验未通过，请重新导入。",
  JOB_NORMALIZER_OUTPUT_INVALID: "岗位信息暂时无法规范化，请稍后重试。",
  JOB_IMPORT_PERSIST_FAILED: "岗位信息暂时无法保存，请稍后重试。",
};

function asSummary(detail: JobImportDetail): JobImportSummary {
  return { importId: detail.importId, inputType: detail.inputType, originalFilename: detail.originalFilename, status: detail.status, failureCode: detail.failureCode, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
}
function insertRecent(previous: JobImportSummary[], next: JobImportSummary): JobImportSummary[] {
  return [next, ...previous.filter((item) => item.importId !== next.importId)].slice(0, 20);
}
function failureMessage(code: string | null | undefined): string | null {
  return code ? failureText[code] ?? "岗位导入暂时不可用，请稍后重试。" : null;
}

export function JobImportView({ initialImports }: JobImportViewProps) {
  const [mode, setMode] = useState<InputMode>("paste");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [recentImports, setRecentImports] = useState(initialImports);
  const [activeImport, setActiveImport] = useState<JobImportSummary | null>(initialImports[0] ?? null);
  const [detail, setDetail] = useState<JobImportDetail | null>(null);
  const [rawEvidence, setRawEvidence] = useState<RawEvidenceState>({ status: "idle" });
  const [actionState, setActionState] = useState<JobImportActionState>(initialActionState);
  const [pollingMessage, setPollingMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [detailReloadRevision, setDetailReloadRevision] = useState(0);
  const evidenceRevisionRef = useRef(0);
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const [isPending, startTransition] = useTransition();
  const activeImportId = activeImport?.importId;
  const detailImportId = detail?.importId;
  const detailStatus = detail?.status;

  const nextEvidenceRevision = useCallback(() => {
    const next = evidenceRevisionRef.current + 1;
    evidenceRevisionRef.current = next;
    setEvidenceRevision(next);
    return next;
  }, []);

  const selectImport = useCallback((next: JobImportSummary) => {
    setActionState(initialActionState);
    setAnnouncement(null);
    setPollingMessage(null);
    if (next.importId === activeImportId) {
      const revision = nextEvidenceRevision();
      if (detailStatus && terminalStatuses.has(detailStatus)) setRawEvidence({ status: "loading", revision });
      setDetailReloadRevision((previous) => previous + 1);
      return;
    }
    nextEvidenceRevision();
    setActiveImport(next);
    setDetail(null);
    setRawEvidence({ status: "idle" });
  }, [activeImportId, detailStatus, nextEvidenceRevision]);

  useEffect(() => {
    if (!activeImportId) return;
    const requestRevision = evidenceRevisionRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/job-imports/${activeImportId}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("无法读取岗位导入");
        const parsed = JobImportDetailSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("无效岗位导入响应");
        if (cancelled) return;
        setDetail(parsed.data);
        setRecentImports((previous) => insertRecent(previous, asSummary(parsed.data)));
        setActiveImport(asSummary(parsed.data));
        setRawEvidence((previous) => {
          if (requestRevision !== evidenceRevisionRef.current) return previous;
          if (!terminalStatuses.has(parsed.data.status)) return { status: "idle" };
          if ((previous.status === "ready" || previous.status === "error") && previous.revision === requestRevision) return previous;
          return { status: "loading", revision: requestRevision };
        });
        setPollingMessage(null);
        if (!terminalStatuses.has(parsed.data.status)) timer = setTimeout(poll, 1_000);
      } catch {
        if (cancelled) return;
        setPollingMessage("暂时无法读取导入状态，请稍后重试。");
        timer = setTimeout(poll, 1_000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeImportId, detailReloadRevision]);

  useEffect(() => {
    if (!detailImportId || !detailStatus) return;
    if (!terminalStatuses.has(detailStatus)) return;
    let cancelled = false;
    void fetch(`/api/job-imports/${detailImportId}/raw`, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.ok && response.headers.get("content-type")?.startsWith("text/plain") ? response.text() : Promise.reject(new Error("raw unavailable")))
      .then((raw) => { if (!cancelled) setRawEvidence({ status: "ready", revision: evidenceRevision, content: raw }); })
      .catch(() => { if (!cancelled) setRawEvidence({ status: "error", revision: evidenceRevision }); });
    return () => { cancelled = true; };
  }, [detailImportId, detailStatus, evidenceRevision]);

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(null), 5_000);
    return () => clearTimeout(timer);
  }, [announcement]);

  function selectMode(next: InputMode) {
    setMode(next);
    document.getElementById(`${next}-tab`)?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: InputMode) {
    const index = inputModes.indexOf(current);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % inputModes.length
      : event.key === "ArrowLeft" ? (index - 1 + inputModes.length) % inputModes.length
      : event.key === "Home" ? 0
      : event.key === "End" ? inputModes.length - 1
      : null;
    if (nextIndex === null) return;
    event.preventDefault();
    selectMode(inputModes[nextIndex]!);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    if (mode === "upload" && file) formData.set("file", file); else if (mode === "url") formData.set("url", url); else formData.set("content", content);
    startTransition(async () => {
      const result = await createJobImportAction(initialActionState, formData);
      setActionState(result);
      if (!result.ok) return;
      const summary: JobImportSummary = { importId: result.import.importId, inputType: result.import.inputType, originalFilename: result.import.originalFilename, status: result.import.status, failureCode: result.import.failureCode, createdAt: result.import.createdAt, updatedAt: result.import.updatedAt };
      setRecentImports((previous) => insertRecent(previous, summary));
      selectImport(summary);
      if (result.import.reused) setAnnouncement("已复用已有岗位导入记录。");
      setContent(""); setFile(null); setUrl("");
    });
  }

  const opportunity = detail?.opportunity;
  const status = detail?.status ?? activeImport?.status;
  const message = !actionState.ok && actionState.message
    ? actionState.message
    : pollingMessage ?? (status ? statusText[status] : "尚未导入岗位。");

  return (
    <main className="container workbench-main job-import-workbench">
      <section aria-labelledby="job-import-title" className="workbench-intro">
        <p className="workbench-kicker">岗位机会 · 主动导入</p><h1 id="job-import-title">导入岗位</h1>
        <p>提交岗位描述或 Markdown 文件后，系统会保留原始证据，并将可确认的信息规范化为岗位机会。</p>
      </section>
      <section aria-labelledby="job-import-form-title" className="job-import-panel">
        <h2 id="job-import-form-title">添加岗位内容</h2>
        <div aria-label="导入方式" className="job-import-tabs" role="tablist">
          <button aria-controls="paste-panel" aria-selected={mode === "paste"} className="workbench-touch-target" id="paste-tab" onClick={() => selectMode("paste")} onKeyDown={(event) => onTabKeyDown(event, "paste")} role="tab" tabIndex={mode === "paste" ? 0 : -1} type="button">粘贴岗位描述</button>
          <button aria-controls="upload-panel" aria-selected={mode === "upload"} className="workbench-touch-target" id="upload-tab" onClick={() => selectMode("upload")} onKeyDown={(event) => onTabKeyDown(event, "upload")} role="tab" tabIndex={mode === "upload" ? 0 : -1} type="button">上传 Markdown</button>
          <button aria-controls="url-panel" aria-selected={mode === "url"} className="workbench-touch-target" id="url-tab" onClick={() => selectMode("url")} onKeyDown={(event) => onTabKeyDown(event, "url")} role="tab" tabIndex={mode === "url" ? 0 : -1} type="button">导入岗位链接</button>
        </div>
        <form onSubmit={submit}>
          {mode === "paste" ? <div aria-labelledby="paste-tab" id="paste-panel" role="tabpanel"><label htmlFor="job-description">岗位描述</label><textarea id="job-description" onChange={(event) => setContent(event.target.value)} placeholder="粘贴你已查看的岗位描述" required value={content} /></div>
            : mode === "url" ? <div aria-labelledby="url-tab" id="url-panel" role="tabpanel"><label htmlFor="job-url">岗位链接</label><input id="job-url" onChange={(event) => setUrl(event.target.value)} placeholder="https://..." required type="url" value={url} /><p>仅导入公开、可访问的具体岗位页面。</p></div>
            : <div aria-labelledby="upload-tab" id="upload-panel" role="tabpanel"><label htmlFor="job-markdown">上传 Markdown 岗位文件</label><input accept=".md,text/markdown" id="job-markdown" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} type="file" /><p>仅支持 UTF-8 Markdown，文件最大 512 KiB。</p></div>}
          <button className="workbench-touch-target job-import-submit" disabled={isPending || (mode === "upload" && !file)} type="submit">{isPending ? "正在导入" : "导入岗位"}</button>
        </form>
        <p aria-live="polite" className="job-import-live" role="status">{message}</p>
        {announcement && <p aria-live="polite">{announcement}</p>}
        {pollingMessage && actionState.ok === false && actionState.message && <p>{pollingMessage}</p>}
      </section>
      <div className="job-import-columns">
        <section aria-labelledby="recent-job-imports-title" className="job-import-panel"><h2 id="recent-job-imports-title">最近导入</h2>
          {recentImports.length === 0 ? <p>尚无岗位导入记录。</p> : <ol className="job-import-recent-list">{recentImports.map((item) => <li key={item.importId}><button aria-pressed={activeImport?.importId === item.importId} className="workbench-touch-target" onClick={() => selectImport(item)} type="button"><span>{item.originalFilename ?? "粘贴的岗位描述"}</span><span>{statusText[item.status]}</span></button></li>)}</ol>}
        </section>
        <section aria-labelledby="opportunity-title" className="job-import-panel"><h2 id="opportunity-title">规范化岗位机会</h2>
          <dl className="job-import-opportunity"><div><dt>公司</dt><dd>{opportunity?.company ?? "未知"}</dd></div><div><dt>职位</dt><dd>{opportunity?.title ?? "未知"}</dd></div><div><dt>地点</dt><dd>{opportunity?.location ?? "未知"}</dd></div><div><dt>发布时间</dt><dd>{opportunity?.postedAt ? new Date(opportunity.postedAt).toLocaleDateString("zh-CN") : "未知"}</dd></div><div><dt>截止日期</dt><dd>{opportunity?.deadline ? new Date(opportunity.deadline).toLocaleDateString("zh-CN") : "未知"}</dd></div></dl>
          {status === "failed" && <p className="job-import-failure">{failureMessage(detail?.failureCode ?? activeImport?.failureCode)}</p>}
          {opportunity?.description && <p className="job-import-description">{opportunity.description}</p>}
        </section>
      </div>
      {detail && <section aria-labelledby="raw-evidence-title" className="job-import-panel"><h2 id="raw-evidence-title">原始证据</h2><p>原文仅供核对，不会被执行或转换为网页内容。</p>
        {!terminalStatuses.has(detail.status) ? <p>岗位完成后可以查看原始证据。</p>
          : rawEvidence.status === "idle" ? <p>原始证据等待读取。</p>
          : rawEvidence.status === "loading" ? <p>正在读取原始证据。</p>
          : rawEvidence.status === "ready" ? <pre>{rawEvidence.content}</pre>
          : <><p>原始证据暂时无法读取，请稍后重试。</p><button className="workbench-touch-target" onClick={() => { const revision = nextEvidenceRevision(); setRawEvidence({ status: "loading", revision }); }} type="button">重试读取原始证据</button></>}
      </section>}
    </main>
  );
}
