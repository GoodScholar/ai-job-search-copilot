"use client";

import type { CandidateFact, CareerImportDetail, CareerImportSummary } from "@job-copilot/contracts/career-import";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { createCareerImportAction, createCareerImportFormAction, initialUploadActionState, type UploadActionState } from "@/app/(workbench)/profile/actions";

type ProfileImportViewProps = {
  initialImport: CareerImportSummary | null;
  initialErrorMessage?: string | null;
};

type ImportStatus = "uploading" | "queued" | "processing" | "completed" | "failed";

const statusText: Record<ImportStatus, string> = {
  uploading: "上传中",
  queued: "等待解析",
  processing: "解析中",
  completed: "解析完成",
  failed: "解析失败",
};

const failureMessages: Record<string, string> = {
  CAREER_IMPORT_QUEUE_UNAVAILABLE: "解析任务暂时不可用，请稍后重试。",
  CAREER_DOCUMENT_NOT_FOUND: "职业资料暂时无法读取，请重新上传后再试。",
  CAREER_DOCUMENT_READ_FAILED: "职业资料暂时无法读取，请稍后重试。",
  CAREER_DOCUMENT_CHECKSUM_MISMATCH: "职业资料校验未通过，请重新上传。",
  CAREER_PARSER_OUTPUT_INVALID: "职业资料暂时无法解析，请稍后重试。",
  CAREER_PARSER_EVIDENCE_INVALID: "职业资料中的证据无法确认，请重新上传后再试。",
  NO_SUPPORTED_FACTS: "没有找到可确认的职业资料事实，请检查 Markdown 内容后重试。",
  CAREER_IMPORT_PERSIST_FAILED: "解析结果暂时无法保存，请稍后重试。",
};

const factTypeNames: Record<CandidateFact["factType"], string> = {
  experience: "工作经历",
  education: "教育经历",
  skill: "技能",
  project: "项目经历",
  language: "语言",
  achievement: "成果",
  certification: "证书",
};

function factValue(fact: CandidateFact): string {
  if ("name" in fact.factValue) {
    const level = "level" in fact.factValue ? fact.factValue.level : undefined;
    if (level) {
      return `${fact.factValue.name} · ${level}`;
    }
    return fact.factValue.name;
  }
  return fact.factValue.summary;
}

function asSummary(detail: CareerImportDetail): CareerImportSummary {
  return {
    importId: detail.importId,
    documentId: detail.documentId,
    sourceFilename: detail.sourceFilename,
    status: detail.status,
    failureCode: detail.failureCode,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    candidateFactCount: detail.facts.length,
  };
}

function hasSameSummary(detail: CareerImportDetail, previous: CareerImportSummary): boolean {
  return detail.status === previous.status
    && detail.failureCode === previous.failureCode
    && detail.updatedAt === previous.updatedAt
    && detail.facts.length === previous.candidateFactCount;
}

export function ProfileImportView({ initialImport, initialErrorMessage = null }: ProfileImportViewProps) {
  const [actionState, setActionState] = useState<UploadActionState>(initialUploadActionState);
  const [isPending, startTransition] = useTransition();
  const [activeImport, setActiveImport] = useState<CareerImportSummary | null>(initialImport);
  const [detail, setDetail] = useState<CareerImportDetail | null>(null);
  const [pollingError, setPollingError] = useState(false);
  const activeImportStatus = useRef<ImportStatus | null>(initialImport?.status ?? null);
  const activeImportId = activeImport?.importId;

  const submitUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const nextState = await createCareerImportAction(initialUploadActionState, formData);
      setActionState(nextState);
      if (nextState.ok) {
        activeImportStatus.current = nextState.import.status;
        setActiveImport({ ...nextState.import, candidateFactCount: 0 });
        setDetail(null);
        setPollingError(false);
      }
    });
  };

  useEffect(() => {
    if (!activeImportId) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const shouldContinuePolling = () => activeImportStatus.current === "queued" || activeImportStatus.current === "processing";
    const scheduleRefresh = () => {
      if (active && shouldContinuePolling()) {
        timer = window.setTimeout(refresh, 1_000);
      }
    };
    const refresh = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(`/api/career-imports/${activeImportId}`, { signal: controller.signal });
        if (!response.ok) throw new Error("career import status unavailable");
        const nextDetail = await response.json() as CareerImportDetail;
        if (!active) return;
        activeImportStatus.current = nextDetail.status;
        setDetail(nextDetail);
        setActiveImport((previous) => previous && !hasSameSummary(nextDetail, previous)
          ? asSummary(nextDetail)
          : previous);
        setPollingError(false);
        scheduleRefresh();
      } catch {
        if (active && !controller?.signal.aborted) {
          setPollingError(true);
          scheduleRefresh();
        }
      }
    };

    void refresh();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [activeImportId]);

  const displayedStatus: ImportStatus | null = isPending
    ? "uploading"
    : activeImport?.status ?? null;
  const failureMessage = detail?.failureCode ? failureMessages[detail.failureCode] ?? "解析失败，请稍后重试。" : null;
  const hasActionResult = actionState.ok || actionState.code !== "";
  const actionFailureMessage = actionState.ok === false && actionState.code ? actionState.message : null;
  const initialQueryErrorMessage = hasActionResult ? null : initialErrorMessage;
  const liveMessage = isPending
    ? statusText.uploading
    : actionFailureMessage
      ? actionFailureMessage
      : initialQueryErrorMessage
        ? initialQueryErrorMessage
        : pollingError
      ? "暂时无法读取解析状态，请稍后重试。"
      : displayedStatus === "failed"
      ? failureMessage ?? "解析失败，请稍后重试。"
      : displayedStatus
        ? statusText[displayedStatus]
        : "请选择一份 Markdown 职业资料后上传。";

  return (
    <main className="container profile-main">
      <section aria-labelledby="profile-title" className="profile-intro">
        <p className="workbench-kicker">职业资料 · 候选事实</p>
        <h1 id="profile-title">从 Markdown 职业资料建立求职画像</h1>
        <p>系统只会提取带原文证据的候选事实；它们需要你的确认后才会进入求职画像。</p>
      </section>

      <section aria-labelledby="profile-upload-title" className="profile-upload">
        <h2 id="profile-upload-title">导入 Markdown 职业资料</h2>
        <form action={createCareerImportFormAction} className="profile-upload-form" onSubmit={submitUpload}>
          <label htmlFor="career-document">选择 Markdown 职业资料</label>
          <input accept=".md,text/markdown,text/plain" className="profile-file-input" id="career-document" name="file" type="file" />
          <button className="profile-upload-button workbench-touch-target" disabled={isPending} type="submit">
            上传并解析
          </button>
        </form>
        <p aria-live="polite" className="profile-status" role="status">{liveMessage}</p>
      </section>

      {detail?.facts.length ? (
        <section aria-labelledby="profile-facts-title" className="profile-facts">
          <div className="profile-facts-heading">
            <div>
              <p className="workbench-kicker">解析结果 · {detail.sourceFilename}</p>
              <h2 id="profile-facts-title">待确认事实</h2>
            </div>
            <p className="profile-pending">待确认</p>
          </div>
          <ol className="profile-fact-list">
            {detail.facts.map((fact) => (
              <li key={fact.factId}>
                <div className="profile-fact-value">
                  <p>{factTypeNames[fact.factType]}</p>
                  <strong>{factValue(fact)}</strong>
                  <span>来源：{fact.evidence.sourceFilename} · 第 {fact.evidence.startLine} 行</span>
                </div>
                <blockquote className="profile-fact-evidence">{fact.evidence.excerpt}</blockquote>
              </li>
            ))}
          </ol>
          <p className="profile-next-step">确认、修改和拒绝将在下一阶段开放</p>
        </section>
      ) : null}
    </main>
  );
}
