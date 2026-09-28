const steps = ["推荐", "材料", "投递", "面试", "结果", "后续规划"] as const;

export function CareerLensJourney() {
  return <section aria-labelledby="career-lens-journey-title" className="career-lens-journey container">
    <h2 id="career-lens-journey-title">一条由你掌控的求职路径</h2>
    <ol aria-label="求职旅程">{steps.map((step) => <li key={step}>{step}</li>)}</ol>
    <p>当前 Alpha 聚焦资料、目标、来源、岗位发现与推荐；后续环节不会伪装成已上线功能。</p>
  </section>;
}
