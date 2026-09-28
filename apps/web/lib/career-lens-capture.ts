export function careerLensCaptureDirectory(value: string | undefined): "before" | "after" | null {
  return value === "before" || value === "after" ? value : null;
}
