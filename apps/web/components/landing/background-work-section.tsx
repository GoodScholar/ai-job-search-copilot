const workflow = [
  ["检查目标公司", "先过滤掉不值得占用你注意力的目标。"],
  ["资格门槛", "把硬性条件和需要确认的门槛拆开。"],
  ["证据匹配", "用你的已验证事实逐条对照岗位要求。"],
  ["生成今日清单", "把值得处理的下一步排到你面前。"],
] as const;

export function BackgroundWorkSection() {
  return (
    <section
      aria-labelledby="background-work-title"
      className="marketing-section background-work-section container"
      id="how-it-works"
    >
      <div className="section-intro">
        <p className="section-kicker">后台工作</p>
        <h2 id="background-work-title">Copilot 在后台工作，你只处理关键决定</h2>
        <p>每天的筛查、比对和整理留在后台；你只在需要判断时介入。</p>
      </div>
      <ol className="editorial-workflow">
        {workflow.map(([title, benefit], index) => (
          <li key={title}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{title}</h3>
              <p>{benefit}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="workflow-outcome">你只处理关键决定</p>
    </section>
  );
}
