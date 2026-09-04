export default function WorkbenchHomeLoading() {
  return (
    <main aria-busy="true" aria-label="正在读取真实求职数据" className="container workbench-main">
      <section className="workbench-loading" role="status">
        <span className="workbench-skeleton workbench-skeleton-kicker" />
        <span className="workbench-skeleton workbench-skeleton-title" />
        <span className="workbench-skeleton workbench-skeleton-copy" />
      </section>
      <div aria-hidden="true" className="workbench-loading-summary">
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
        <span className="workbench-skeleton" />
      </div>
    </main>
  );
}
