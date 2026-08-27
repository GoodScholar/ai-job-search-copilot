export const CAREER_PRIVACY_SCAN_VERSION = "career-privacy-v1";
export const CAREER_PRIVACY_MODES = ["sanitized_only", "retain_protected_original"] as const;
/** DOCX 中存在嵌入媒体时，两端写入的可审计、可脱敏的规范文本标记。 */
export const DOCX_EMBEDDED_MEDIA_MARKER = "[DOCX 嵌入照片或二维码]";
/**
 * DOCX 是不可信 ZIP；在交给 Mammoth 前只读取 central directory 的元数据。
 * 2 MiB 为 512 KiB 上传上限预留四倍 XML/样式开销，32 倍压缩比仍覆盖普通文本，
 * 同时拒绝异常多文件、过大的单文件/总解压尺寸和压缩比，避免小压缩包耗尽资源。
 */
export const DOCX_ARCHIVE_MAX_ENTRIES = 64;
export const DOCX_ARCHIVE_MAX_ENTRY_UNCOMPRESSED_BYTES = 1 * 1024 * 1024;
export const DOCX_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
export const DOCX_ARCHIVE_MAX_COMPRESSION_RATIO = 32;

export type DocxArchiveEntryMetadata = {
  dir: boolean;
  compressedSize: number;
  uncompressedSize: number;
};

export function isDocxArchiveWithinBudget(entries: readonly DocxArchiveEntryMetadata[], archiveByteLength: number): boolean {
  if (!Number.isSafeInteger(archiveByteLength) || archiveByteLength < 1 || entries.length > DOCX_ARCHIVE_MAX_ENTRIES) return false;
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)
      || entry.compressedSize < 0 || entry.uncompressedSize < 0
      || entry.uncompressedSize > DOCX_ARCHIVE_MAX_ENTRY_UNCOMPRESSED_BYTES) return false;
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > DOCX_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES
      || entry.uncompressedSize > Math.max(1, entry.compressedSize) * DOCX_ARCHIVE_MAX_COMPRESSION_RATIO) return false;
  }
  return totalUncompressed <= archiveByteLength * DOCX_ARCHIVE_MAX_COMPRESSION_RATIO;
}

export type CareerPrivacyMode = typeof CAREER_PRIVACY_MODES[number];

export function isCareerPrivacyMode(value: unknown): value is CareerPrivacyMode {
  return typeof value === "string" && CAREER_PRIVACY_MODES.includes(value as CareerPrivacyMode);
}

export type CareerPrivacyFindingKind =
  | "name"
  | "phone"
  | "email"
  | "address"
  | "identity_number"
  | "image_or_qr"
  | "social_account";

export type CareerPrivacyFinding = {
  kind: CareerPrivacyFindingKind;
  line: number;
  maskedPreview: string;
};

export type CareerPrivacyInspection = {
  version: typeof CAREER_PRIVACY_SCAN_VERSION;
  findings: CareerPrivacyFinding[];
  sanitizedMarkdown: string;
};

type Detection = CareerPrivacyFinding & {
  start: number;
  end: number;
  replacement: string;
};

const placeholders = new Set([
  "[姓名]",
  "[手机号]",
  "[邮箱]",
  "[详细住址]",
  "[证件号码]",
  "[照片或二维码]",
  "[社交账号]",
]);

const sensitiveImageCue = /(?:照片|头像|证件照|二维码|avatar|headshot|profile[-_ ]?photo|qr(?:code)?)/iu;

function lineNumber(markdown: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (markdown.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function maskName(value: string): string {
  const characters = Array.from(value.trim());
  return `${characters[0] ?? ""}${"*".repeat(Math.max(1, characters.length - 1))}`;
}

function maskEmail(value: string): string {
  const [local = "", domain = ""] = value.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return `${digits.slice(-11, -8)}****${digits.slice(-4)}`;
}

function maskIdentityNumber(value: string): string {
  return `${value.slice(0, 6)}********${value.slice(-4)}`;
}

function maskText(value: string): string {
  const characters = Array.from(value.trim());
  return `${characters.slice(0, 2).join("")}***`;
}

function collect(
  markdown: string,
  pattern: RegExp,
  input: {
    kind: CareerPrivacyFindingKind;
    replacement: string | ((value: string) => string);
    preview: (value: string) => string;
    valueGroup?: number;
    accept?: (value: string) => boolean;
  },
): Detection[] {
  const detections: Detection[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const value = match[input.valueGroup ?? 0];
    if (!value || match.index === undefined || placeholders.has(value.trim()) || input.accept?.(value) === false) continue;
    const relativeStart = (input.valueGroup ?? 0) === 0 ? 0 : match[0].indexOf(value);
    const start = match.index + relativeStart;
    detections.push({
      kind: input.kind,
      line: lineNumber(markdown, start),
      maskedPreview: input.preview(value),
      replacement: typeof input.replacement === "string" ? input.replacement : input.replacement(value),
      start,
      end: start + value.length,
    });
  }
  return detections;
}

export function inspectCareerDocumentPrivacy(markdown: string): CareerPrivacyInspection {
  const addressDetections = collect(markdown, /^(\s*(?:[-*+]\s*)?(?:详细住址|家庭住址|现居地址|联系地址|住址)\s*[：:]\s*)([^\r\n]+?)(?=\s*(?:[｜|·•]|\s[-–—]\s)|$)/gmu, {
    kind: "address",
    replacement: "[详细住址]",
    preview: maskText,
    valueGroup: 2,
  });
  const socialDetections = collect(markdown, /^(\s*(?:[-*+]\s*)?(?:微信号?|WeChat|QQ|微博|LinkedIn|领英|社交账号)\s*[：:]\s*)([^\r\n]+?)(?=\s*(?:[｜|·•]|\s[-–—]\s)|$)/gimu, {
    kind: "social_account",
    replacement: "[社交账号]",
    preview: maskText,
    valueGroup: 2,
  });
  const linkedInDetections = collect(markdown, /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Z0-9._~!$&'()*+,;=:@%/-]+/giu, {
    kind: "social_account",
    replacement: "[社交账号]",
    preview: maskText,
  });
  const emailDetections = collect(markdown, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, {
    kind: "email",
    replacement: "[邮箱]",
    preview: maskEmail,
  });
  const phoneDetections = collect(markdown, /(?<!\d)(?:(?:\+?86)[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/gu, {
    kind: "phone",
    replacement: "[手机号]",
    preview: maskPhone,
  });
  const identityNumberDetections = collect(markdown, /(?<![0-9A-Za-z])\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9A-Za-z])/gu, {
    kind: "identity_number",
    replacement: "[证件号码]",
    preview: maskIdentityNumber,
  });
  const hasPersonalResumeContext = [
    addressDetections,
    socialDetections,
    linkedInDetections,
    emailDetections,
    phoneDetections,
    identityNumberDetections,
  ].some((items) => items.length > 0) || /\[(?:邮箱|手机号|详细住址|证件号码|社交账号)\]/u.test(markdown);
  const hasResumeStructure = /^#{2,6}\s*(?:个人简介|个人概况|求职意向|教育经历|工作经历|实习经历|项目经历|专业技能|技能)(?:\s|$)/mu.test(markdown);
  const hasSingleH1 = [...markdown.matchAll(/^#(?!#)\s+\S.*$/gmu)].length === 1;
  const referenceImages = [...markdown.matchAll(/!\[([^\]\r\n]*)\](?:\[([^\]\r\n]*)\])?(?!\s*\()/gu)];
  const sensitiveReferenceIds = new Set(
    referenceImages
      .filter((match) => sensitiveImageCue.test(match[1] ?? ""))
      .map((match) => ((match[2] ?? "").trim() || (match[1] ?? "").trim()).toLocaleLowerCase()),
  );
  const detections = [
    ...collect(markdown, new RegExp(DOCX_EMBEDDED_MEDIA_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu"), {
      kind: "image_or_qr",
      replacement: "[照片或二维码]",
      preview: () => "[DOCX 嵌入媒体]",
    }),
    ...(hasPersonalResumeContext && hasResumeStructure && hasSingleH1 ? collect(markdown, /^(#\s+)([\p{Script=Han}][\p{Script=Han}·]{1,5})(\s*)$/gmu, {
      kind: "name",
      replacement: "[姓名]",
      preview: maskName,
      valueGroup: 2,
      accept: (value) => !/(?:简历|工程师|设计师|经理|总监|顾问|专员|公司|集团|科技|招聘|岗位|团队|工作室|大学|学院|银行)$/u.test(value.trim()),
    }) : []),
    ...collect(markdown, /^(\s*(?:(?:[-*+]|#{1,6})\s*)?(?:姓名|名字|Name)\s*[：:]\s*)([^\r\n]{1,40}?)(?=\s*(?:[｜|·•,，;；/／]|\s[-–—]\s)|$)/gimu, {
      kind: "name",
      replacement: "[姓名]",
      preview: maskName,
      valueGroup: 2,
    }),
    ...addressDetections,
    ...socialDetections,
    ...collect(markdown, /!\[[^\]\r\n]*\]\([^\)\r\n]+\)/gu, {
      kind: "image_or_qr",
      replacement: "[照片或二维码]",
      preview: () => "[图片引用]",
      accept: (value) => sensitiveImageCue.test(value),
    }),
    ...collect(markdown, /\[(?:个人)?(?:照片|头像|二维码)[^\]\r\n]*\]\([^\)\r\n]+\)/gu, {
      kind: "image_or_qr",
      replacement: "[照片或二维码]",
      preview: () => "[图片或二维码链接]",
    }),
    ...collect(markdown, /<img\b[^>]*>/giu, {
      kind: "image_or_qr",
      replacement: (value) => `[照片或二维码]${value.match(/\r\n|\r|\n/g)?.join("") ?? ""}`,
      preview: () => "[HTML 图片]",
      accept: (value) => sensitiveImageCue.test(value),
    }),
    ...collect(markdown, /!\[[^\]\r\n]*\](?:\[[^\]\r\n]*\])?(?!\s*\()/gu, {
      kind: "image_or_qr",
      replacement: "[照片或二维码]",
      preview: () => "[引用式图片]",
      accept: (value) => sensitiveImageCue.test(value),
    }),
    ...collect(markdown, /^\s*\[[^\]\r\n]+\]:[^\r\n]+$/gmu, {
      kind: "image_or_qr",
      replacement: "[照片或二维码]",
      preview: () => "[图片资源定义]",
      accept: (value) => {
        const referenceId = /^\s*\[([^\]]+)\]/u.exec(value)?.[1]?.trim().toLocaleLowerCase();
        return Boolean(referenceId && sensitiveReferenceIds.has(referenceId));
      },
    }),
    ...linkedInDetections,
    ...emailDetections,
    ...phoneDetections,
    ...identityNumberDetections,
  ].sort((left, right) => left.start - right.start || right.end - left.end);

  const accepted: Detection[] = [];
  for (const detection of detections) {
    if (accepted.some((item) => detection.start < item.end && detection.end > item.start)) continue;
    accepted.push(detection);
  }

  let sanitizedMarkdown = markdown;
  for (const detection of [...accepted].sort((left, right) => right.start - left.start)) {
    sanitizedMarkdown = `${sanitizedMarkdown.slice(0, detection.start)}${detection.replacement}${sanitizedMarkdown.slice(detection.end)}`;
  }

  return {
    version: CAREER_PRIVACY_SCAN_VERSION,
    findings: accepted.map(({ kind, line, maskedPreview }) => ({ kind, line, maskedPreview })),
    sanitizedMarkdown,
  };
}
