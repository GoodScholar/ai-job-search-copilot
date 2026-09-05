import type { Metadata } from "next";
import { ModelConnectionView } from "@/components/workbench/model-connection-view";
import { getModelDiagnostics } from "@/lib/server/model-diagnostics";

export const metadata: Metadata = { title: "模型连接 | AI Job Search Copilot" };

export default async function ModelConnectionPage() {
  return <ModelConnectionView initialDiagnostics={await getModelDiagnostics()} />;
}
