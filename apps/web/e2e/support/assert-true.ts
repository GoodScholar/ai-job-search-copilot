import { expect } from "@playwright/test";

/** Keeps audit failures limited to a boolean and this neutral helper frame. */
export function expectTrue(value: boolean): void {
  expect.soft(value).toBe(true);
}

export function assertTrue(value: boolean): void {
  expect(value).toBe(true);
}
