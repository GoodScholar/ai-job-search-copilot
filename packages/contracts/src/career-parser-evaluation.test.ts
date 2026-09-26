import { describe, expect, it } from "vitest";
import { assertCareerParserEvaluation, CAREER_PARSER_EVALUATION_FACTS } from "./career-parser-evaluation";

const output = () => ({ adapter: "fake", parserVersion: "fake-career-parser-v1", promptVersion: "career-import-prompt-v1", outputSchemaVersion: "career-facts-v1", facts: CAREER_PARSER_EVALUATION_FACTS });

describe("career-parser-eval-v1", () => {
  it("要求完整原文证据并限制延迟", () => {
    expect(assertCareerParserEvaluation(output(), 10)).toEqual({ evaluationVersion: "career-parser-eval-v1", factCount: 2 });
    expect(() => assertCareerParserEvaluation(output(), 25_001)).toThrow("CAREER_PARSER_EVALUATION_LATENCY");
  });
  it("拒绝遗漏、额外注入事实和伪造证据", () => {
    expect(() => assertCareerParserEvaluation({ ...output(), facts: [] }, 10)).toThrow();
    expect(() => assertCareerParserEvaluation({ ...output(), facts: [...CAREER_PARSER_EVALUATION_FACTS, CAREER_PARSER_EVALUATION_FACTS[0]] }, 10)).toThrow();
    expect(() => assertCareerParserEvaluation({ ...output(), facts: CAREER_PARSER_EVALUATION_FACTS.map(fact => ({ ...fact, evidence: { ...fact.evidence, startLine: 99, endLine: 99 } })) }, 10)).toThrow();
  });
});
