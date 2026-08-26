export function ResumeFormatSection() {
  return (
    <section className="marketing-section resume-format-section container" aria-labelledby="resume-format-title">
      <div className="section-intro">
        <p className="section-kicker">材料格式</p>
        <h2 id="resume-format-title">一份画像，多种简历格式</h2>
        <p>Markdown 是一级导入/导出格式，便于审阅、编辑和留存版本。</p>
      </div>
      <div className="resume-formats" aria-label="支持的简历格式">
        <p>Markdown</p>
        <p>DOCX</p>
        <p>PDF</p>
      </div>
      <p className="format-note">导入内容会先作为候选信息展示，不会直接覆盖已确认画像。</p>
    </section>
  );
}
