"use client";

import { ResolveCareerFactConflictResponseSchema, type CandidateFact, type CareerImportDetail, type CareerImportSummary } from "@job-copilot/contracts/career-import";
import { ProfileSnapshotSchema, type ProfileFact, type ProfileFactType, type ProfileSnapshot } from "@job-copilot/contracts/profile-review";
import {
  inspectCareerDocumentPrivacy,
  type CareerPrivacyInspection,
  type CareerPrivacyMode,
} from "@job-copilot/contracts/career-document-privacy";
import { useCallback, useEffect, useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { createCareerImportAction, type UploadActionState } from "@/app/(workbench)/profile/actions";
import { DocxCareerProcessingError, extractCanonicalDocxParagraphText } from "@/lib/docx-career-processing";
import { PdfCareerProcessingError, extractCanonicalPdfPageText } from "@/lib/pdf-career-processing";

type ProfileImportViewProps = {
  initialImports: CareerImportSummary[];
  initialProfile?: ProfileSnapshot;
};

type ImportStatus = "uploading" | "queued" | "processing" | "completed" | "failed";

type PreparedCareerDocument = {
  file: File;
  processingText: string;
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
  CAREER_IMPORT_FACT_LIMIT_EXCEEDED: "最多提取 500 条候选事实，请精简职业资料后重试。",
  CAREER_PARSER_OUTPUT_INVALID: "职业资料暂时无法解析，请稍后重试。",
  CAREER_PARSER_EVIDENCE_INVALID: "职业资料中的证据无法确认，请重新上传后再试。",
  NO_SUPPORTED_FACTS: "没有找到可确认的职业资料事实，请检查职业资料内容后重试。",
  CAREER_IMPORT_PERSIST_FAILED: "解析结果暂时无法保存，请稍后重试。",
  CAREER_DOCUMENT_INVALID_PDF: "PDF 文件无法解析，请重新选择文件。",
  CAREER_DOCUMENT_ENCRYPTED_PDF: "PDF 已加密，无法读取，请解除加密后重试。",
  CAREER_DOCUMENT_PDF_NO_TEXT: "PDF 没有可读取的文本层，请上传文本型 PDF。",
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
const profileFactTypeNames = { ...factTypeNames, work_eligibility: "工作资格" } as const;

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

function evidenceLocation(fact: CandidateFact): string {
  const evidence = fact.evidence;
  return evidence.locatorType === "pdf_pages"
    ? `第 ${evidence.startPage}-${evidence.endPage} 页`
    : evidence.locatorType === "docx_paragraphs"
    ? `第 ${evidence.startParagraph}-${evidence.endParagraph} 段`
    : `第 ${evidence.startLine}-${evidence.endLine} 行`;
}

function profileFactValue(fact: ProfileFact): string {
  if ("name" in fact.factValue) {
    const level = "level" in fact.factValue ? fact.factValue.level : undefined;
    return level ? `${fact.factValue.name} · ${level}` : fact.factValue.name;
  }
  return fact.factValue.summary;
}

function correctedFactValue(fact: CandidateFact, value: string, level = "") {
  if (fact.factType === "language") {
    return level.trim() ? { name: value, level: level.trim() } : { name: value };
  }
  if ("name" in fact.factValue) {
    return { name: value };
  }
  return { summary: value };
}

function profileInputValue(factType: ProfileFactType, value: string, level = "") {
  if (factType === "language") {
    return level.trim() ? { name: value, level: level.trim() } : { name: value };
  }
  if (factType === "skill" || factType === "certification") {
    return { name: value };
  }
  return { summary: value };
}

function profileFactInputValue(fact: ProfileFact): string {
  return "name" in fact.factValue ? fact.factValue.name : fact.factValue.summary;
}

function profileFactLanguageLevel(fact: ProfileFact): string {
  return fact.factType === "language" && "level" in fact.factValue ? fact.factValue.level ?? "" : "";
}

function candidateFactLanguageLevel(fact: CandidateFact): string {
  return fact.factType === "language" && "level" in fact.factValue ? fact.factValue.level ?? "" : "";
}

function asSummary(detail: CareerImportDetail): CareerImportSummary {
  return {
    importId: detail.importId,
    documentId: detail.documentId,
    sourceFilename: detail.sourceFilename,
    sourceFormat: detail.sourceFormat,
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

async function readCareerDocumentText(file: File): Promise<string> {
  if (/\.docx$/i.test(file.name)) return extractCanonicalDocxParagraphText(file);
  if (/\.pdf$/i.test(file.name)) return extractCanonicalPdfPageText(file);
  return readFileText(file);
}

export function ProfileImportView({ initialImports, initialProfile = { profileId: null, version: 0, facts: [] } }: ProfileImportViewProps) {
  const [actionState, setActionState] = useState<UploadActionState>(initialUploadActionState);
  const [isPending, startTransition] = useTransition();
  const [recentImports, setRecentImports] = useState<CareerImportSummary[]>(initialImports);
  const [activeImport, setActiveImport] = useState<CareerImportSummary | null>(initialImports[0] ?? null);
  const [detail, setDetail] = useState<CareerImportDetail | null>(null);
  const [profile, setProfile] = useState<ProfileSnapshot>(initialProfile);
  const [decidedCandidateFactIds, setDecidedCandidateFactIds] = useState<Set<string>>(() => new Set());
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [correctingFactId, setCorrectingFactId] = useState<string | null>(null);
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionLevel, setCorrectionLevel] = useState("");
  const [manualFactType, setManualFactType] = useState<ProfileFactType>("skill");
  const [manualFactValue, setManualFactValue] = useState("");
  const [manualLanguageLevel, setManualLanguageLevel] = useState("");
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingReason, setEditingReason] = useState("");
  const [editingLanguageLevel, setEditingLanguageLevel] = useState("");
  const [removingFactId, setRemovingFactId] = useState<string | null>(null);
  const [removalReason, setRemovalReason] = useState("");
  const [pollingError, setPollingError] = useState(false);
  const [preparedDocument, setPreparedDocument] = useState<PreparedCareerDocument | null>(null);
  const [privacyMode, setPrivacyMode] = useState<CareerPrivacyMode | null>(null);
  const [confirmedSanitized, setConfirmedSanitized] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState<string | null>(null);
  const [hasPendingFileSelection, setHasPendingFileSelection] = useState(false);
  const privacyGeneration = useRef(0);
  const pollingGeneration = useRef<{ value: number; initialStatus: ImportStatus | null }>({
    value: 0,
    initialStatus: initialImports[0]?.status ?? null,
  });
  const [pollRevision, setPollRevision] = useState(0);
  const activeImportId = activeImport?.importId;
  const pendingConflictFactIds = new Set((detail?.conflicts ?? [])
    .filter((conflict) => conflict.status === "pending")
    .flatMap((conflict) => [conflict.existingFact.factId, conflict.incomingFact.factId]));
  const moveToRecentTop = useCallback((nextImport: CareerImportSummary) => {
    setRecentImports((previous) => [nextImport, ...previous.filter((item) => item.importId !== nextImport.importId)].slice(0, 20));
  }, []);
  const updateRecentInPlace = useCallback((nextImport: CareerImportSummary) => {
    setRecentImports((previous) => previous.map((item) => item.importId === nextImport.importId ? nextImport : item));
  }, []);
  const submitCandidateDecision = useCallback(async (
    fact: CandidateFact,
    decision: { decision: "confirmed" | "rejected" } | { decision: "corrected"; factValue: unknown; reason: string },
  ) => {
    setProfileMessage(null);
    try {
      const response = await fetch(`/api/profile/candidate-facts/${fact.factId}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: profile.version, ...decision }),
      });
      if (!response.ok) {
        setProfileMessage(response.status === 409 ? "画像已在其他位置更新，请刷新后重试。" : "无法保存审核决定，请稍后重试。");
        return;
      }
      const parsed = ProfileSnapshotSchema.safeParse(await response.json());
      if (!parsed.success) {
        setProfileMessage("无法读取最新画像，请刷新后重试。");
        return;
      }
      setProfile(parsed.data);
      setDecidedCandidateFactIds((previous) => new Set(previous).add(fact.factId));
      setCorrectingFactId(null);
      setCorrectionValue("");
      setCorrectionReason("");
      setCorrectionLevel("");
    } catch {
      setProfileMessage("无法保存审核决定，请稍后重试。");
    }
  }, [profile.version]);

  const resolveConflict = useCallback(async (conflictId: string, resolution: "use_existing" | "use_incoming" | "keep_both") => {
    setProfileMessage(null);
    try {
      const response = await fetch(`/api/profile/fact-conflicts/${conflictId}/resolutions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: profile.version, resolution }) });
      if (!response.ok) { setProfileMessage(response.status === 409 ? "画像已在其他位置更新，请刷新后重试。" : "无法解决职业事实冲突，请稍后重试。"); return; }
      const parsed = ResolveCareerFactConflictResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setProfileMessage("无法读取最新画像，请刷新后重试。"); return; }
      setProfile(parsed.data.profile);
      const previousConflict = detail?.conflicts?.find((conflict) => conflict.conflictId === conflictId);
      if (previousConflict) setDecidedCandidateFactIds((previous) => new Set([
        ...previous, previousConflict.existingFact.factId, previousConflict.incomingFact.factId,
      ]));
      setDetail((current) => current ? { ...current, conflicts: (current.conflicts ?? []).map((conflict) => conflict.conflictId === conflictId ? { ...conflict, ...parsed.data.conflict } : conflict) } : current);
    } catch { setProfileMessage("无法解决职业事实冲突，请稍后重试。"); }
  }, [detail, profile.version]);

  const submitProfileMaintenance = useCallback(async (path: string, body: Record<string, unknown>) => {
    setProfileMessage(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: profile.version, ...body }),
      });
      if (!response.ok) {
        setProfileMessage(response.status === 409 ? "画像已在其他位置更新，请刷新后重试。" : "无法维护画像事实，请稍后重试。");
        return;
      }
      const parsed = ProfileSnapshotSchema.safeParse(await response.json());
      if (!parsed.success) {
        setProfileMessage("无法读取最新画像，请刷新后重试。");
        return;
      }
      setProfile(parsed.data);
      setManualFactValue("");
      setManualLanguageLevel("");
      setEditingFactId(null);
      setEditingValue("");
      setEditingReason("");
      setEditingLanguageLevel("");
      setRemovingFactId(null);
      setRemovalReason("");
    } catch {
      setProfileMessage("无法维护画像事实，请稍后重试。");
    }
  }, [profile.version]);

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
      setHasPendingFileSelection(false);
      setPrivacyMessage("请选择一份 Markdown、DOCX 或 PDF 职业资料后上传。");
      return;
    }
    setHasPendingFileSelection(true);
    setPrivacyMessage("正在浏览器中检查敏感信息…");
    void readCareerDocumentText(file).then((markdown) => {
      if (privacyGeneration.current !== generation) return;
      const inspection = inspectCareerDocumentPrivacy(markdown);
      setPreparedDocument({ file, processingText: markdown, inspection });
      setPrivacyMessage(inspection.findings.length > 0
        ? `发现 ${inspection.findings.length} 项敏感信息，请选择隐私处理方式。`
        : "未发现常见敏感信息，请确认你已自行检查后继续。");
    }).catch((error: unknown) => {
      if (privacyGeneration.current !== generation) return;
      setPrivacyMessage((error instanceof DocxCareerProcessingError || error instanceof PdfCareerProcessingError) && error.code === "TOO_LARGE"
        ? error.message
        : error instanceof PdfCareerProcessingError && error.code === "NO_TEXT"
          ? "该 PDF 没有可读取的文本层，请上传文本型 PDF。"
          : error instanceof PdfCareerProcessingError && error.code === "ENCRYPTED_PDF"
            ? "该 PDF 已加密，无法读取，请解除加密后重试。"
            : error instanceof PdfCareerProcessingError && error.code === "TOO_COMPLEX"
              ? "该 PDF 结构过于复杂，无法安全读取，请拆分或精简后重试。"
            : "浏览器无法读取该文件，请重新选择有效的 Markdown、DOCX 或 PDF 职业资料。");
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
      { type: /\.docx$/i.test(preparedDocument.file.name)
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : /\.pdf$/i.test(preparedDocument.file.name) ? "application/pdf" : "text/markdown", lastModified: preparedDocument.file.lastModified },
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
        setHasPendingFileSelection(false);
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
      : hasPendingFileSelection && privacyMessage
        ? privacyMessage
      : pollingError
      ? "暂时无法读取解析状态，请稍后重试。"
      : displayedStatus === "failed"
      ? failureMessage ?? "解析失败，请稍后重试。"
        : displayedStatus
        ? statusText[displayedStatus]
        : privacyMessage
          ? privacyMessage
        : "请选择一份 Markdown、DOCX 或 PDF 职业资料后上传。";

  return (
    <main className="container profile-main">
      <section aria-labelledby="profile-title" className="profile-intro">
        <p className="workbench-kicker">职业资料 · 候选事实</p>
        <h1 id="profile-title">从职业资料建立求职画像</h1>
        <p>系统只会提取带原文证据的候选事实；它们需要你的确认后才会进入求职画像。</p>
      </section>

      <section aria-labelledby="profile-upload-title" className="profile-upload">
        <h2 id="profile-upload-title">导入职业资料</h2>
        <div className="profile-privacy-reminder" role="note">
          <strong>上传前先检查隐私</strong>
          <p>请检查姓名、手机号、邮箱、详细住址、证件号码、照片、二维码和社交账号。自动检查可能遗漏内容，请勿使用随机生成的真实身份替换。</p>
        </div>
        <form className="profile-upload-form" onSubmit={submitUpload}>
          <label htmlFor="career-document">选择 Markdown、DOCX 或 PDF 职业资料</label>
          <input
            accept=".md,.docx,.pdf,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
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
            {detail.facts.filter((fact) => !decidedCandidateFactIds.has(fact.factId)).map((fact) => (
              <li key={fact.factId}>
                <div className="profile-fact-value">
                  <p>{factTypeNames[fact.factType]}</p>
                  <strong>{factValue(fact)}</strong>
                  <span>来源：{fact.evidence.sourceFilename} · <span>{fact.evidence.locatorType === "pdf_pages" ? `第 ${fact.evidence.startPage} 页` : fact.evidence.locatorType === "docx_paragraphs" ? `第 ${fact.evidence.startParagraph} 段` : `第 ${fact.evidence.startLine} 行`}</span></span>
                </div>
                <blockquote className="profile-fact-evidence">{fact.evidence.excerpt}</blockquote>
                {!pendingConflictFactIds.has(fact.factId) ? <div className="profile-fact-actions">
                  <button aria-label={`确认 ${factValue(fact)}`} className="workbench-touch-target" onClick={() => void submitCandidateDecision(fact, { decision: "confirmed" })} type="button">确认</button>
                  <button
                    aria-label={`纠正 ${factValue(fact)}`}
                    className="workbench-touch-target"
                    onClick={() => {
                      setCorrectingFactId(fact.factId);
                      setCorrectionValue("");
                      setCorrectionReason("");
                      setCorrectionLevel(candidateFactLanguageLevel(fact));
                    }}
                    type="button"
                  >纠正</button>
                  <button aria-label={`拒绝 ${factValue(fact)}`} className="workbench-touch-target" onClick={() => void submitCandidateDecision(fact, { decision: "rejected" })} type="button">拒绝</button>
                </div> : null}
                {!pendingConflictFactIds.has(fact.factId) && correctingFactId === fact.factId ? (
                  <form
                    className="profile-fact-correction"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!correctionValue.trim() || !correctionReason.trim()) return;
                      void submitCandidateDecision(fact, {
                        decision: "corrected",
                        factValue: correctedFactValue(fact, correctionValue.trim(), correctionLevel),
                        reason: correctionReason.trim(),
                      });
                    }}
                  >
                    <label>纠正后的内容
                      <input onChange={(event) => setCorrectionValue(event.target.value)} value={correctionValue} />
                    </label>
                    <label>纠正原因
                      <input onChange={(event) => setCorrectionReason(event.target.value)} value={correctionReason} />
                    </label>
                    {fact.factType === "language" ? <label>纠正后的语言级别
                      <input onChange={(event) => setCorrectionLevel(event.target.value)} value={correctionLevel} />
                    </label> : null}
                    <button disabled={!correctionValue.trim() || !correctionReason.trim()} type="submit">保存纠正</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {(detail?.conflicts?.length ?? 0) > 0 ? <section aria-labelledby="career-conflicts-title" className="profile-facts">
        <h2 id="career-conflicts-title">职业事实冲突</h2>
        {detail!.conflicts.map((conflict) => <article key={conflict.conflictId}>
          <p>{({ date: "日期", role: "职位", organization: "机构", metric: "成果指标" } as const)[conflict.kind]}不一致 · {conflict.status === "pending" ? "待处理" : "已解决"}</p>
          <p>已有（{conflict.existingFact.evidence.sourceFilename}）：{factValue(conflict.existingFact)}（{evidenceLocation(conflict.existingFact)}：{conflict.existingFact.evidence.excerpt}）</p>
          <p>新导入（{conflict.incomingFact.evidence.sourceFilename}）：{factValue(conflict.incomingFact)}（{evidenceLocation(conflict.incomingFact)}：{conflict.incomingFact.evidence.excerpt}）</p>
          {conflict.status === "pending" ? <div className="profile-fact-actions">
            <button type="button" onClick={() => void resolveConflict(conflict.conflictId, "use_existing")}>采用已有</button>
            <button type="button" onClick={() => void resolveConflict(conflict.conflictId, "use_incoming")}>采用新导入</button>
            <button type="button" onClick={() => void resolveConflict(conflict.conflictId, "keep_both")}>两者都有效</button>
          </div> : null}
        </article>)}
      </section> : null}

      <section aria-labelledby="trusted-profile-title" className="profile-facts">
        <div className="profile-facts-heading">
          <div>
            <p className="workbench-kicker">长期记忆 · 已验证</p>
            <h2 id="trusted-profile-title">当前可信画像</h2>
          </div>
          <p className="profile-pending">版本 {profile.version}</p>
        </div>
        {profile.facts.length ? <Link className="profile-target-link workbench-touch-target" href="/profile/targets">确认求职目标</Link> : null}
        <form
          className="profile-fact-correction"
          onSubmit={(event) => {
            event.preventDefault();
            if (!manualFactValue.trim()) return;
            void submitProfileMaintenance("/api/profile/facts", {
              factType: manualFactType,
              factValue: profileInputValue(manualFactType, manualFactValue.trim(), manualLanguageLevel),
            });
          }}
        >
          <label>画像事实类型
            <select onChange={(event) => setManualFactType(event.target.value as ProfileFactType)} value={manualFactType}>
              {Object.entries(profileFactTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>画像事实内容
            <input onChange={(event) => setManualFactValue(event.target.value)} value={manualFactValue} />
          </label>
          {manualFactType === "language" ? <label>画像事实语言级别
            <input onChange={(event) => setManualLanguageLevel(event.target.value)} value={manualLanguageLevel} />
          </label> : null}
          <button disabled={!manualFactValue.trim()} type="submit">新增画像事实</button>
        </form>
        {profile.facts.length ? (
          <ol className="profile-fact-list">
            {profile.facts.map((fact) => (
              <li key={fact.factId}>
                <div className="profile-fact-value">
                  <p>{profileFactTypeNames[fact.factType]}</p>
                  <strong>{profileFactValue(fact)}</strong>
                  <span>{fact.source === "candidate_fact" ? "已保留原候选事实证据" : "由你确认"}</span>
                </div>
                <div className="profile-fact-actions">
                  <button
                    aria-label={`修改 ${profileFactTypeNames[fact.factType]}`}
                    className="workbench-touch-target"
                    onClick={() => {
                      setEditingFactId(fact.factId);
                      setEditingValue(profileFactInputValue(fact));
                      setEditingReason("");
                      setEditingLanguageLevel(profileFactLanguageLevel(fact));
                      setRemovingFactId(null);
                    }}
                    type="button"
                  >修改</button>
                  <button
                    aria-label={`移除 ${profileFactTypeNames[fact.factType]}`}
                    className="workbench-touch-target"
                    onClick={() => {
                      setRemovingFactId(fact.factId);
                      setRemovalReason("");
                      setEditingFactId(null);
                    }}
                    type="button"
                  >移除</button>
                </div>
                {editingFactId === fact.factId ? (
                  <form
                    className="profile-fact-correction"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!editingValue.trim() || !editingReason.trim()) return;
                      void submitProfileMaintenance(`/api/profile/facts/${fact.factId}/revisions`, {
                        factValue: profileInputValue(fact.factType, editingValue.trim(), editingLanguageLevel), reason: editingReason.trim(),
                      });
                    }}
                  >
                    <label>修改后的内容
                      <input onChange={(event) => setEditingValue(event.target.value)} value={editingValue} />
                    </label>
                    <label>修改原因
                      <input onChange={(event) => setEditingReason(event.target.value)} value={editingReason} />
                    </label>
                    {fact.factType === "language" ? <label>修改后的语言级别
                      <input onChange={(event) => setEditingLanguageLevel(event.target.value)} value={editingLanguageLevel} />
                    </label> : null}
                    <button disabled={!editingValue.trim() || !editingReason.trim()} type="submit">保存修改</button>
                  </form>
                ) : null}
                {removingFactId === fact.factId ? (
                  <form
                    className="profile-fact-correction"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!removalReason.trim()) return;
                      void submitProfileMaintenance(`/api/profile/facts/${fact.factId}/removals`, { reason: removalReason.trim() });
                    }}
                  >
                    <label>移除原因
                      <input onChange={(event) => setRemovalReason(event.target.value)} value={removalReason} />
                    </label>
                    <button disabled={!removalReason.trim()} type="submit">确认移除</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        ) : <p className="profile-next-step">尚无已验证画像事实。</p>}
        {profileMessage ? <p aria-live="polite" className="profile-next-step" role="status">{profileMessage}</p> : null}
      </section>
    </main>
  );
}
