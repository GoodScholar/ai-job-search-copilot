import Link from "next/link";
import { endSessionAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { WorkbenchNavigation } from "@/components/workbench/workbench-navigation";

export function WorkbenchHeader() {
  async function submitEndSession(): Promise<void> {
    "use server";
    await endSessionAction();
  }

  return (
    <header className="workbench-header">
      <div className="container workbench-header-inner">
        <Link aria-label="AI Job Search Copilot" className="workbench-brand workbench-touch-target" href="/home">
          <span>Job Copilot</span>
          <small>你的求职工作台</small>
        </Link>
        <WorkbenchNavigation />
        <form action={submitEndSession}>
          <Button className="workbench-signout workbench-touch-target" size="lg" type="submit" variant="outline">退出</Button>
        </form>
      </div>
    </header>
  );
}
