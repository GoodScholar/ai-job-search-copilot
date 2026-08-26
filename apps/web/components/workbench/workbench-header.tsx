import Link from "next/link";
import { endSessionAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";

const navigation = ["首页", "推荐", "投递", "画像"] as const;

export function WorkbenchHeader() {
  async function submitEndSession(): Promise<void> {
    "use server";
    await endSessionAction();
  }

  return (
    <header className="workbench-header">
      <div className="container workbench-header-inner">
        <Link className="workbench-brand workbench-touch-target" href="/home">AI Job Search Copilot</Link>
        <nav aria-label="求职工作台导航" className="workbench-nav">
          {navigation.map((item) => item === "首页" ? (
            <Link aria-current="page" className="workbench-nav-link workbench-touch-target" href="/home" key={item}>{item}</Link>
          ) : (
            <span aria-disabled="true" className="workbench-nav-pending" key={item}>{item}</span>
          ))}
        </nav>
        <form action={submitEndSession}>
          <Button className="workbench-signout workbench-touch-target" size="lg" type="submit" variant="outline">退出</Button>
        </form>
      </div>
    </header>
  );
}
