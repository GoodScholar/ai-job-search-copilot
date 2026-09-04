/** 仅测试运行时使用；domain 的精确枚举仍是 public runtime contract。 */
export const fakeAnysearchPublicJobPhase = "fake-anysearch-public-job-v1";
export const fakeAnysearchPublicJobMissingKeyPhase = "fake-anysearch-public-job-missing-key-v1";

export function isConfiguredFakeAnysearchPublicJobPhase(value) {
  return value === fakeAnysearchPublicJobPhase;
}

export function isFakeAnysearchPublicJobPhase(value) {
  return isConfiguredFakeAnysearchPublicJobPhase(value) || value === fakeAnysearchPublicJobMissingKeyPhase;
}
