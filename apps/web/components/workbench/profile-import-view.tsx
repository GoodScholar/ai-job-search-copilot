"use client";

import type { CandidateFact, CareerImportDetail, CareerImportSummary } from "@job-copilot/contracts/career-import";
import {
  inspectCareerDocumentPrivacy,
  type CareerPrivacyInspection,
  type CareerPrivacyMode,
} from "@job-copilot/contracts/career-document-privacy";
import { useCallback, useEffect, useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { createCareerImportAction, type UploadActionState } from "@/app/(workbench)/profile/actions";

type ProfileImportViewProps = {
  initialImports: CareerImportSummary[];
};

type ImportStatus = "uploading" | "queued" | "processing" | "completed" | "failed";

type PreparedCareerDocument = {
  file: File;
  inspection: CareerPrivacyInspection;
};

const statusText: Record<ImportStatus, string> = {
  uploading: "上传中",
  queued: "等待解析",
  processing: "解析中",
  completed: "解析完成",
  failed: "解析失败",
};

const initialUploadActionState: UploadActionState = { ok: false, code: "", message: "" };

const privacyFindingNames: Record<CareerPrivacyInspection["findings"][number]["kind"], string> = {
  name: "姓名",
  phone: "手机号",
  email: "邮箱",
  address: "详细住址",
  identity_number: "证件号码",
  image_or_qr: "照片或二维码",
  social_account: "社交账号",
};

const privacyStatusText: Record<CareerImportSummary["privacyStatus"], string> = {
  legacy_unreviewed: "旧版未检查",
  sanitized_only: "仅保存脱敏副本",
  sanitized_with_protected_original: "原件受保护，下游使用脱敏副本",
};

const failureMessages: Record<string, string> = {
  CAREER_IMPORT_QUEUE_UNAVAILABLE: "解析任务暂时不可用，请稍后重试。",
  CAREER_DOCUMENT_NOT_FOUND: "职业资料暂时无法读取，请重新上传后再试。",
  CAREER_DOCUMENT_READ_FAILED: "职业资料暂时无法读取，请稍后重试。",
  CAREER_DOCUMENT_PRIVACY_UNVERIFIED: "该职业资料尚未完成隐私检查，请重新上传脱敏副本。",
  CAREER_DOCUMENT_CHECKSUM_MISMATCH: "职业资料校验未通过，请重新上传。",
  CAREER_IMPORT_FACT_LIMIT_EXCEEDED: "最多提取 500 条候选事实，请精简 Markdown 后重试。",
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
    privacyStatus: detail.privacyStatus,
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

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("无法读取职业资料")));
    reader.readAsText(file, "utf-8");
  });
}

export function ProfileImportView({ initialImports }: ProfileImportViewProps) {
  const [actionState, setActionState] = useState<UploadActionState>(initialUploadActionState);
  const [isPending, startTransition] = useTransition();
  const [recentImports, setRecentImports] = useState<CareerImportSummary[]>(initialImports);
  const [activeImport, setActiveImport] = useState<CareerImportSummary | null>(initialImports[0] ?? null);
  const [detail, setDetail] = useState<CareerImportDetail | null>(null);
  const [pollingError, setPollingError] = useState(false);
  const [preparedDocument, setPreparedDocument] = useState<PreparedCareerDocument | null>(null);
  const [privacyMode, setPrivacyMode] = useState<CareerPrivacyMode | null>(null);
  const [confirmedSanitized, setConfirmedSanitized] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState<string | null>(null);
  const privacyGeneration = useRef(0);
  const pollingGeneration = useRef<{ value: number; initialStatus: ImportStatus | null }>({
    value: 0,
    initialStatus: initialImports[0]?.status ?? null,
  });
  const [pollRevision, setPollRevision] = useState(0);
  const activeImportId = activeImport?.importId;
  const moveToRecentTop = useCallback((nextImport: CareerImportSummary) => {
    setRecentImports((previous) => [nextImport, ...previous.filter((item) => item.importId !== nextImport.importId)].slice(0, 20));
  }, []);
  const updateRecentInPlace = useCallback((nextImport: CareerImportSummary) => {
    setRecentImports((previous) => previous.map((item) => item.importId === nextImport.importId ? nextImport : item));
  }, []);

  const selectImport = (nextImport: CareerImportSummary) => {
    pollingGeneration.current = {
      value: pollingGeneration.current.value + 1,
      initialStatus: nextImport.status,
    };
    setPollRevision((revision) => revision + 1);
    setActiveImport(nextImport);
    setDetail(null);
    setPollingError(false);
  };

  const inspectSelectedFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    const generation = privacyGeneration.current + 1;
    privacyGeneration.current = generation;
    setPreparedDocument(null);
    setPrivacyMode(null);
    setConfirmedSanitized(false);
    if (!file) {
      setPrivacyMessage("请选择一份 Markdown 职业资料后上传。");
      return;
    }
    setPrivacyMessage("正在浏览器中检查敏感信息…");
    void readFileText(file).then((markdown) => {
      if (privacyGeneration.current !== generation) return;
      const inspection = inspectCareerDocumentPrivacy(markdown);
      setPreparedDocument({ file, inspection });
      setPrivacyMessage(inspection.findings.length > 0
        ? `发现 ${inspection.findings.length} 项敏感信息，请选择隐私处理方式。`
        : "未发现常见敏感信息，请确认你已自行检查后继续。");
    }).catch(() => {
      if (privacyGeneration.current !== generation) return;
      setPrivacyMessage("浏览器无法读取该文件，请重新选择 UTF-8 Markdown 文件。");
    });
  };

  const canSubmit = Boolean(preparedDocument && (
    preparedDocument.inspection.findings.length > 0
      ? privacyMode
      : confirmedSanitized
  ));

  const submitUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preparedDocument || !canSubmit) {
      setPrivacyMessage("请先完成敏感信息检查并确认隐私处理方式。");
      return;
    }
    const selectedMode: CareerPrivacyMode = preparedDocument.inspection.findings.length > 0
      ? privacyMode!
      : "sanitized_only";
    const formData = new FormData();
    formData.set("privacyMode", selectedMode);
    formData.set("file", new File(
      [preparedDocument.inspection.sanitizedMarkdown],
      preparedDocument.file.name,
      { type: "text/markdown", lastModified: preparedDocument.file.lastModified },
    ));
    if (selectedMode === "retain_protected_original") {
      formData.set("protectedOriginal", preparedDocument.file);
    }
    startTransition(async () => {
      const nextState = await createCareerImportAction(initialUploadActionState, formData);
      if (nextState.ok) {
        pollingGeneration.current = {
          value: pollingGeneration.current.value + 1,
          initialStatus: nextState.import.status,
        };
        setPollRevision((revision) => revision + 1);
        setActionState(nextState);
        const nextImport = { ...nextState.import, candidateFactCount: 0 };
        setActiveImport(nextImport);
        moveToRecentTop(nextImport);
        setDetail(null);
        setPollingError(false);
        return;
      }
      setActionState(nextState);
    });
  };

  useEffect(() => {
    if (!activeImportId) return;
    const generation = pollingGeneration.current;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let status = generation.initialStatus;
    const isCurrent = () => active && pollingGeneration.current === generation;
    const shouldContinuePolling = () => status === "queued" || status === "processing";
    const scheduleRefresh = () => {
      if (isCurrent() && shouldContinuePolling()) {
        timer = window.setTimeout(refresh, 1_000);
      }
    };
    const refresh = async () => {
      if (!isCurrent()) return;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/career-imports/${activeImportId}`, { signal: controller.signal });
        if (!response.ok) throw new Error("career import status unavailable");
        const nextDetail = await response.json() as CareerImportDetail;
        if (!isCurrent()) return;
        status = nextDetail.status;
        setDetail(nextDetail);
        updateRecentInPlace(asSummary(nextDetail));
        setActiveImport((previous) => previous && !hasSameSummary(nextDetail, previous)
          ? asSummary(nextDetail)
          : previous);
        setPollingError(false);
        scheduleRefresh();
      } catch {
        if (isCurrent() && !controller?.signal.aborted) {
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
  }, [activeImportId, pollRevision, updateRecentInPlace]);

  const displayedStatus: ImportStatus | null = isPending
    ? "uploading"
    : activeImport?.status ?? null;
  const failureMessage = detail?.failureCode ? failureMessages[detail.failureCode] ?? "解析失败，请稍后重试。" : null;
  const actionFailureMessage = actionState.ok === false && actionState.code ? actionState.message : null;
  const liveMessage = isPending
    ? statusText.uploading
    : actionFailureMessage
      ? actionFailureMessage
      : pollingError
      ? "暂时无法读取解析状态，请稍后重试。"
      : displayedStatus === "failed"
      ? failureMessage ?? "解析失败，请稍后重试。"
        : displayedStatus
        ? statusText[displayedStatus]
        : privacyMessage
          ? privacyMessage
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
        <div className="profile-privacy-reminder" role="note">
          <strong>上传前先检查隐私</strong>
          <p>请检查姓名、手机号、邮箱、详细住址、证件号码、照片、二维码和社交账号。自动检查可能遗漏内容，请勿使用随机生成的真实身份替换。</p>
        </div>
        <form className="profile-upload-form" onSubmit={submitUpload}>
          <label htmlFor="career-document">选择 Markdown 职业资料</label>
          <input
            accept=".md,text/markdown,text/plain"
            className="profile-file-input"
            id="career-document"
            name="careerDocument"
            onChange={inspectSelectedFile}
            type="file"
          />

          {preparedDocument?.inspection.findings.length ? (
            <div className="profile-privacy-review">
              <div className="profile-privacy-review-heading">
                <strong>发现 {preparedDocument.inspection.findings.length} 项敏感信息</strong>
                <span>原文仅在当前浏览器中用于生成预览</span>
              </div>
              <ol className="profile-privacy-finding-list">
                {preparedDocument.inspection.findings.map((finding, index) => (
                  <li key={`${finding.kind}-${finding.line}-${index}`}>
                    <span>{privacyFindingNames[finding.kind]}</span>
                    <span>第 {finding.line} 行</span>
                    <code>{finding.maskedPreview}</code>
                  </li>
                ))}
              </ol>
              <details className="profile-privacy-preview">
                <summary>查看脱敏处理副本</summary>
                <pre>{preparedDocument.inspection.sanitizedMarkdown}</pre>
              </details>
              <fieldset className="profile-privacy-options">
                <legend>隐私处理方式</legend>
                <label>
                  <input
                    checked={privacyMode === "sanitized_only"}
                    name="privacyChoice"
                    onChange={() => setPrivacyMode("sanitized_only")}
                    type="radio"
                  />
                  仅上传脱敏副本（原件不离开浏览器）
                </label>
                <label>
                  <input
                    checked={privacyMode === "retain_protected_original"}
                    name="privacyChoice"
                    onChange={() => setPrivacyMode("retain_protected_original")}
                    type="radio"
                  />
                  保留受保护原件（下游仍只使用脱敏副本）
                </label>
              </fieldset>
            </div>
          ) : preparedDocument ? (
            <label className="profile-privacy-confirmation">
              <input
                checked={confirmedSanitized}
                onChange={(event) => setConfirmedSanitized(event.currentTarget.checked)}
                type="checkbox"
              />
              我已检查该文件，并确认它不含其他需要处理的敏感信息
            </label>
          ) : null}

          <button className="profile-upload-button workbench-touch-target" disabled={isPending || !canSubmit} type="submit">
            上传并解析
          </button>
        </form>
        <p aria-live="polite" className="profile-status" role="status">{liveMessage}</p>
      </section>

      {recentImports.length ? (
        <section aria-labelledby="profile-recent-imports-title" className="profile-recent-imports">
          <div className="profile-recent-imports-heading">
            <h2 id="profile-recent-imports-title">最近导入</h2>
            <p>最多显示 20 条职业资料导入记录。</p>
          </div>
          <ol className="profile-recent-import-list">
            {recentImports.map((item) => {
              const itemFailure = item.failureCode ? failureMessages[item.failureCode] ?? "解析失败，请稍后重试。" : null;
              return (
                <li key={item.importId}>
                  <button
                    aria-pressed={item.importId === activeImportId}
                    className="profile-recent-import-button workbench-touch-target"
                    onClick={() => selectImport(item)}
                    type="button"
                  >
                    <span>{item.sourceFilename}</span>
                    <span>{statusText[item.status]}</span>
                    <span>{privacyStatusText[item.privacyStatus]}</span>
                    <span>{item.status === "failed" ? itemFailure : `候选事实 ${item.candidateFactCount} 条`}</span>
                    <time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 16).replace("T", " ")}</time>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

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
                  <span>来源：{fact.evidence.sourceFilename} · <span>第 {fact.evidence.startLine} 行</span></span>
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
