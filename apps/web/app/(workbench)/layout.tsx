import { WorkbenchHeader } from "@/components/workbench/workbench-header";
import type { ReactNode } from "react";

export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="workbench-shell">
      <aside aria-label="职业透镜工作台侧栏" className="workbench-sidebar">
        <WorkbenchHeader />
      </aside>
      <div className="workbench-content">{children}</div>
    </div>
  );
}
