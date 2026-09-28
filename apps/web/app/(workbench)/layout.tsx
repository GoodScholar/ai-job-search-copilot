import { WorkbenchHeader } from "@/components/workbench/workbench-header";
import type { ReactNode } from "react";

export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="workbench-shell">
      <aside aria-label="求职工作台" className="workbench-sidebar">
        <WorkbenchHeader />
      </aside>
      <div className="workbench-content">{children}</div>
    </div>
  );
}
