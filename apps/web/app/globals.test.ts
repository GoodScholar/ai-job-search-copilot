import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("allows long source filenames to wrap inside profile facts", async () => {
  const css = await readFile(resolve(process.cwd(), "app/globals.css"), "utf8");

  expect(css).toMatch(/\.profile-facts-heading > div \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.profile-fact-value span \{[^}]*overflow-wrap: anywhere;/);
});
