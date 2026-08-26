import { WorkbenchHeader } from "@/components/workbench/workbench-header";
import type { ReactNode } from "react";

export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <WorkbenchHeader />
      {children}
    </>
  );
}
