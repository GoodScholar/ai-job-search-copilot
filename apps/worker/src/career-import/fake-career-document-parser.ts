import {
  CAREER_IMPORT_MAX_FACTS,
  parseMarkdownHeading,
  parseQuotedCareerFactValue,
  type CareerParserFact,
} from "@job-copilot/contracts/career-import";

type FactType = CareerParserFact["factType"];

const sectionAliases = new Map<string, FactType>([
  ["技能", "skill"], ["skills", "skill"], ["technical skills", "skill"],
  ["工作经历", "experience"], ["工作经验", "experience"], ["experience", "experience"], ["work experience", "experience"],
  ["教育", "education"], ["教育经历", "education"], ["education", "education"],
  ["项目", "project"], ["项目经历", "project"], ["projects", "project"],
  ["语言", "language"], ["languages", "language"],
  ["成果", "achievement"], ["主要成果", "achievement"], ["achievements", "achievement"],
  ["证书", "certification"], ["认证", "certification"], ["certifications", "certification"],
]);

type ActiveSection = {
  factType: FactType;
  headingLevel: number;
};

const listItemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;

export class FakeCareerDocumentParser {
  async parse(markdown: string): Promise<unknown> {
    const facts: CareerParserFact[] = [];
    let activeSection: ActiveSection | undefined;
    let lineNumber = 0;

    for (const line of normalizedLines(markdown)) {
      if (facts.length >= CAREER_IMPORT_MAX_FACTS + 1) break;
      lineNumber += 1;
      const heading = parseMarkdownHeading(line);

      if (heading) {
        const headingLevel = heading.level;
        const headingText = heading.text;
        const factType = sectionAliases.get(headingText.toLowerCase());

        if (factType) {
          activeSection = { factType, headingLevel };
        } else if (activeSection && headingLevel <= activeSection.headingLevel) {
          activeSection = undefined;
        } else if (activeSection) {
          const fact = createFact(activeSection.factType, line, lineNumber);
          if (fact) facts.push(fact);
        }
        continue;
      }

      if (!activeSection) continue;

      const listItem = line.match(listItemPattern);
      if (!listItem) continue;

      const fact = createFact(activeSection.factType, line, lineNumber);
      if (fact) facts.push(fact);
    }

    return {
      adapter: "fake",
      parserVersion: "fake-career-parser-v1",
      promptVersion: "career-import-prompt-v1",
      outputSchemaVersion: "career-facts-v1",
      facts,
    };
  }
}

function* normalizedLines(markdown: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character !== "\n" && character !== "\r") continue;
    yield markdown.slice(start, index);
    if (character === "\r" && markdown[index + 1] === "\n") index += 1;
    start = index + 1;
  }
  yield markdown.slice(start);
}

function createFact(
  factType: FactType,
  excerpt: string,
  lineNumber: number,
): CareerParserFact | undefined {
  const factValue = parseQuotedCareerFactValue(factType, excerpt);
  if (!factValue) return undefined;

  const evidence = {
    locatorType: "markdown_lines" as const,
    startLine: lineNumber,
    endLine: lineNumber,
    excerpt,
  };

  return {
    factType,
    factValue,
    confidenceBasisPoints: 10_000,
    grounding: "quoted",
    evidence,
  } as CareerParserFact;
}
