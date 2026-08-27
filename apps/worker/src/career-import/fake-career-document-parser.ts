import {
  CareerParserOutputSchema,
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

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const listItemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;

export class FakeCareerDocumentParser {
  async parse(markdown: string): Promise<unknown> {
    const facts: CareerParserFact[] = [];
    let activeSection: ActiveSection | undefined;

    for (const [index, line] of markdown.replace(/\r\n?/g, "\n").split("\n").entries()) {
      const lineNumber = index + 1;
      const heading = line.match(headingPattern);

      if (heading) {
        const headingLevel = heading[1].length;
        const headingText = heading[2].trim();
        const factType = sectionAliases.get(headingText.toLowerCase());

        if (factType) {
          activeSection = { factType, headingLevel };
        } else if (activeSection && headingLevel <= activeSection.headingLevel) {
          activeSection = undefined;
        } else if (activeSection) {
          const fact = createFact(activeSection.factType, headingText, line, lineNumber);
          if (fact) facts.push(fact);
        }
        continue;
      }

      if (!activeSection) continue;

      const listItem = line.match(listItemPattern);
      if (!listItem) continue;

      const fact = createFact(activeSection.factType, listItem[1].trim(), line, lineNumber);
      if (fact) facts.push(fact);
    }

    return CareerParserOutputSchema.parse({
      adapter: "fake",
      parserVersion: "fake-career-parser-v1",
      promptVersion: "career-import-prompt-v1",
      outputSchemaVersion: "career-facts-v1",
      facts,
    });
  }
}

function createFact(
  factType: FactType,
  value: string,
  excerpt: string,
  lineNumber: number,
): CareerParserFact | undefined {
  if (!value) return undefined;

  const evidence = {
    locatorType: "markdown_lines" as const,
    startLine: lineNumber,
    endLine: lineNumber,
    excerpt,
  };

  if (factType === "skill" || factType === "certification") {
    return {
      factType,
      factValue: { name: value },
      confidenceBasisPoints: 10_000,
      grounding: "quoted",
      evidence,
    };
  }

  if (factType === "language") {
    const language = value.match(/^(.+?)[：:]\s*(.+)$/);
    return {
      factType,
      factValue: language
        ? { name: language[1].trim(), level: language[2].trim() }
        : { name: value },
      confidenceBasisPoints: 10_000,
      grounding: "quoted",
      evidence,
    };
  }

  return {
    factType,
    factValue: { summary: value },
    confidenceBasisPoints: 10_000,
    grounding: "quoted",
    evidence,
  };
}
