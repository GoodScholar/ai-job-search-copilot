import type { ProfileReviewCommands, TrustedProfileQueries } from "@job-copilot/domain/profile-review";

export const PROFILE_REVIEW_COMMANDS = Symbol("PROFILE_REVIEW_COMMANDS");
export const TRUSTED_PROFILE_QUERIES = Symbol("TRUSTED_PROFILE_QUERIES");

export type { ProfileReviewCommands, TrustedProfileQueries };
