import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, canonicalJsonSha256 } from "./agent-runs";

describe("agent run canonical content", () => {
  it("递归排序原始 JSON 对象键后再编码和哈希", () => {
    const first = { z: [{ b: 2, a: 1 }], a: { d: true, c: null } };
    const second = { a: { c: null, d: true }, z: [{ a: 1, b: 2 }] };

    expect(new TextDecoder().decode(canonicalJsonBytes(first))).toBe('{"a":{"c":null,"d":true},"z":[{"a":1,"b":2}]}');
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
  });
});
