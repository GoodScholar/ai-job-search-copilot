const externalActions = ["提交申请", "发送邮件", "联系招聘者"] as const;

export function ApprovalBoundarySection() {
  return (
    <section className="marketing-section approval-boundary-section container" aria-labelledby="approval-boundary-title">
      <div className="section-intro">
        <p className="section-kicker">审批边界</p>
        <h2 id="approval-boundary-title">任何外部行动，都先经过你的确认</h2>
        <p>Copilot 可以自动完成内部分析和材料准备；决定权始终在你手中。</p>
      </div>
      <div className="approval-ledger">
        <div>
          <h3>审批线内</h3>
          <p>内部分析、证据比对、材料草稿和待办整理。</p>
        </div>
        <div>
          <h3>审批线外</h3>
          <ul>
            {externalActions.map((action) => <li key={action}>{action}</li>)}
          </ul>
        </div>
      </div>
      <p className="approval-note">本地 Beta 不自动执行外部行动</p>
    </section>
  );
}
