import { expect } from "vitest";

const configuredScheme = String.fromCharCode(66, 101, 97, 114, 101, 114);

export function assertConfiguredCredential(observed: unknown, configured: string): void {
  expect(observed === `${configuredScheme} ${configured}`).toBe(true);
}
