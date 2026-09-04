import { expect } from "@playwright/test";

export function assertFalse(value: boolean): void {
  expect(value).toBe(false);
}
