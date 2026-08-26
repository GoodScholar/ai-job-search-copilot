const evidenceChain = [
  ["简历来源", "项目经历条目（示例）"],
  ["已验证画像事实", "主导 React 应用架构拆分（示例）"],
  ["岗位要求", "需要 React 架构设计经验（示例）"],
  ["推荐解释", "架构拆分经验与该项要求直接对应（示例）"],
] as const;

export function EvidenceChainSection() {
  return (
    <section
      aria-labelledby="evidence-chain-title"
      className="marketing-section evidence-chain-section container"
      id="evidence-and-control"
    >
      <div className="section-intro">
        <p className="section-kicker">证据链 · 示例</p>
        <h2 id="evidence-chain-title">值得投，不只是一个分数</h2>
        <p>每个推荐都能回到具体来源和岗位要求；来源可追溯，缺口不隐藏。</p>
      </div>
      <ol className="evidence-chain" aria-label="推荐依据示例">
        {evidenceChain.map(([label, detail], index) => (
          <li key={label}>
            <span aria-hidden="true">{index + 1}</span>
            <div>
              <h3>{label}</h3>
              <p>{detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="evidence-notes">
        <p>来源可追溯</p>
        <p>缺口不隐藏</p>
      </div>
    </section>
  );
}
