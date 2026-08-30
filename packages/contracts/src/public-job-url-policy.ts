import { parse } from "tldts";
import { z } from "zod";

export const PublicJobIdentityParameterNames = Object.freeze([
  "id", "job", "jobid", "job_id", "openingid", "opening_id", "positionid", "position_id", "requisitionid", "requisition_id",
]);

const publicJobIdentityParameters = new Set(PublicJobIdentityParameterNames);
const publicJobIdentityValue = /^[A-Za-z0-9._~-]{1,128}$/u;
const publicDnsLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

const isIpv4Literal = (value: string): boolean => {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
};

export function isPublicJobIdentityParameterName(value: string): boolean {
  return publicJobIdentityParameters.has(value.toLowerCase());
}

export function isPublicJobIdentityValue(value: string): boolean {
  return publicJobIdentityValue.test(value);
}

export function isLexicallyValidDnsHostname(value: string): boolean {
  if (value.length > 253 || value !== value.toLowerCase() || isIpv4Literal(value)) return false;
  const labels = value.split(".");
  return labels.length >= 2
    && labels.every((label) => label.length >= 1 && label.length <= 63 && publicDnsLabel.test(label))
    && !(value === "localhost" || value.endsWith(".localhost"));
}

export function isPublicJobDiscoveryHostname(value: string): boolean {
  if (!isLexicallyValidDnsHostname(value) || ["invalid", "test", "example", "onion", "arpa"].some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) return false;
  const parsed = parse(value, { allowPrivateDomains: true });
  return parsed.domain !== null && Boolean(parsed.isIcann || parsed.isPrivate);
}

export const SafeNormalizedPublicJobUrlSchema = z.url().max(2_048).superRefine((value, context) => {
  const url = new URL(value);
  const hasUnsafeAuthority = url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || !isPublicJobDiscoveryHostname(url.hostname);
  const invalidQueryParameter = [...url.searchParams].some(([key, parameterValue]) => !isPublicJobIdentityParameterName(key) || !isPublicJobIdentityValue(parameterValue));
  if (hasUnsafeAuthority || invalidQueryParameter) {
    context.addIssue({ code: "custom", message: "lead URLs must be normalized HTTPS URLs with only public job identity query parameters" });
  }
});
