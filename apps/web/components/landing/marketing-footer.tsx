import webPackage from "@/package.json";

export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="container">
        <p>AI Job Search Copilot</p>
        <p>v{webPackage.version} · 外部行动需确认</p>
      </div>
    </footer>
  );
}
