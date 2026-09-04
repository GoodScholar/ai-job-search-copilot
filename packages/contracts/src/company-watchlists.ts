import { z } from "zod";
import { isLexicallyValidDnsHostname } from "./public-job-url-policy";

const version = z.int().min(0);
const positiveInteger = z.int().min(1);
const sensitiveQueryKeySegments = new Set([
  "token", "auth", "session", "password", "secret", "key", "code",
]);

function isCredentialQueryKey(value: string): boolean {
  const segments = value
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]+/u)
    .filter(Boolean);
  return segments.some((segment) => sensitiveQueryKeySegments.has(segment));
}

function isAllowedCareersUrl(value: string, allowedDomains: string[]): boolean {
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host.includes(":") || !isLexicallyValidDnsHostname(host)) return false;
    if (Array.from(url.searchParams.keys()).some(isCredentialQueryKey)) return false;
    return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

const canonicalCompanyName = z.string().trim().min(1).max(200);
const allowedDomain = z.string().trim().toLowerCase().refine(isLexicallyValidDnsHostname, "must be a public DNS name");
const allowedDomains = z.array(allowedDomain).min(1).max(20).refine(
  (values) => new Set(values).size === values.length,
  { message: "allowed domains must be unique" },
);
const careersUrl = z.string().trim().min(1).max(2_048);
const sourceNote = z.string().trim().max(500).nullable();

const watchlistItemFields = {
  canonicalCompanyName,
  careersUrl,
  allowedDomains,
  sourceNote,
};

const commandItemFields = z.object(watchlistItemFields).strict().superRefine((value, context) => {
  if (!isAllowedCareersUrl(value.careersUrl, value.allowedDomains)) {
    context.addIssue({ code: "custom", path: ["careersUrl"], message: "must be a public URL hosted by an allowed domain without credentials" });
  }
});

export const CompanyWatchlistItemSchema = z.object({
  itemId: z.uuid(),
  ...watchlistItemFields,
  state: z.enum(["enabled", "disabled"]),
  position: positiveInteger,
}).strict().superRefine((value, context) => {
  if (!isAllowedCareersUrl(value.careersUrl, value.allowedDomains)) {
    context.addIssue({ code: "custom", path: ["careersUrl"], message: "must be a public URL hosted by an allowed domain without credentials" });
  }
});

export const CompanyWatchlistOverviewSchema = z.object({
  target: z.object({
    targetId: z.uuid(),
    targetVersion: positiveInteger,
    targetState: z.enum(["active", "inactive"]),
    roleFamily: z.string().trim().min(1).max(200),
  }).strict(),
  version,
  items: z.array(CompanyWatchlistItemSchema).max(50),
}).strict().superRefine((value, context) => {
  const itemIds = value.items.map(({ itemId }) => itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "item IDs must be unique" });
  }
  if (value.items.some(({ position }, index) => position !== index + 1)) {
    context.addIssue({ code: "custom", path: ["items"], message: "item positions must be contiguous" });
  }
  if ((value.version === 0) !== (value.items.length === 0)) {
    context.addIssue({ code: "custom", path: ["items"], message: "version zero must represent an empty Watchlist" });
  }
});

export const AddCompanyWatchlistItemCommandSchema = commandItemFields.extend({ expectedVersion: version }).strict();
export const ReviseCompanyWatchlistItemCommandSchema = AddCompanyWatchlistItemCommandSchema;
export const ReorderCompanyWatchlistCommandSchema = z.object({
  expectedVersion: version,
  orderedItemIds: z.array(z.uuid()).min(1).max(50).refine(
    (values) => new Set(values).size === values.length,
    { message: "item IDs must be unique" },
  ),
}).strict();
export const SetCompanyWatchlistItemStateCommandSchema = z.object({
  expectedVersion: version,
  state: z.enum(["enabled", "disabled"]),
}).strict();

export type CompanyWatchlistItem = z.infer<typeof CompanyWatchlistItemSchema>;
export type CompanyWatchlistOverview = z.infer<typeof CompanyWatchlistOverviewSchema>;
export type AddCompanyWatchlistItemCommand = z.infer<typeof AddCompanyWatchlistItemCommandSchema>;
export type ReviseCompanyWatchlistItemCommand = z.infer<typeof ReviseCompanyWatchlistItemCommandSchema>;
export type ReorderCompanyWatchlistCommand = z.infer<typeof ReorderCompanyWatchlistCommandSchema>;
export type SetCompanyWatchlistItemStateCommand = z.infer<typeof SetCompanyWatchlistItemStateCommandSchema>;
