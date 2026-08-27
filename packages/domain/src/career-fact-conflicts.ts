type Fact = {
  factType: string;
  factValue: { summary?: string; name?: string };
};

/** 仅用职位与机构两个明确锚点判断同一职业事件，避免猜测性合并。 */
export function detectCareerFactConflict(left: Fact, right: Fact): { kind: "date" | "role" | "organization" | "metric" } | null {
  if (left.factType !== right.factType) return null;
  if (left.factType === "achievement") {
    const leftSummary = left.factValue.summary ?? "";
    const rightSummary = right.factValue.summary ?? "";
    const skeleton = (value: string) => value.replace(/\d+(?:\.\d+)?(?:%|％|万|k|K)?/gu, "#");
    const leftSkeleton = skeleton(leftSummary);
    const rightSkeleton = skeleton(rightSummary);
    const semanticLength = leftSkeleton.replace(/[^\p{L}]/gu, "").length;
    return semanticLength >= 3 && leftSkeleton === rightSkeleton && leftSummary !== rightSummary ? { kind: "metric" } : null;
  }
  if (left.factType === "education") {
    const leftParts = left.factValue.summary?.split("｜").map((part) => part.trim()) ?? [];
    const rightParts = right.factValue.summary?.split("｜").map((part) => part.trim()) ?? [];
    return leftParts.length >= 3 && rightParts.length >= 3
      && leftParts[1] === rightParts[1] && leftParts[2] === rightParts[2] && leftParts[0] !== rightParts[0]
      ? { kind: "organization" } : null;
  }
  if (left.factType !== "experience") return null;
  const leftParts = left.factValue.summary?.split("｜").map((part) => part.trim()) ?? [];
  const rightParts = right.factValue.summary?.split("｜").map((part) => part.trim()) ?? [];
  if (leftParts.length < 3 || rightParts.length < 3) return null;
  const [leftRole, leftOrganization, leftDate] = leftParts;
  const [rightRole, rightOrganization, rightDate] = rightParts;
  if (leftOrganization === rightOrganization && leftDate === rightDate && leftRole !== rightRole) return { kind: "role" };
  if (leftRole === rightRole && leftDate === rightDate && leftOrganization !== rightOrganization) return { kind: "organization" };
  if (leftRole === rightRole && leftOrganization === rightOrganization && leftDate !== rightDate) return { kind: "date" };
  return null;
}
