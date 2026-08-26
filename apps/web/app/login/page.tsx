import { getPublicAuthMode, resolveInternalReturnTo } from "@/lib/auth-mode";

type LoginPageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { returnTo } = await searchParams;
  const authMode = getPublicAuthMode({
    NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE,
  });
  const safeReturnTo = resolveInternalReturnTo(returnTo);
  const adapterStatus = authMode === "wechat"
    ? "微信 OAuth Adapter 待服务端接入"
    : "本地开发登录";

  return (
    <main className="container py-16 sm:py-24">
      <section aria-labelledby="login-boundary-title" className="max-w-2xl border-y border-[var(--rule)] py-10">
        <p className="section-kicker">登录边界 · 邀请制 Beta</p>
        <h1 id="login-boundary-title" className="mt-3 text-[clamp(2.25rem,5vw,4rem)] font-bold tracking-[-0.04em] leading-[1.05]">
          登录尚未开放
        </h1>
        {authMode === "dev" ? (
          <>
            <p className="mt-5 text-[var(--muted)] leading-7">正式邀请制 Beta 将使用微信登录</p>
            <p className="mt-2 text-[var(--muted)] leading-7">
              本实施批次只建立登录边界，尚未创建用户会话
            </p>
          </>
        ) : null}
        <dl className="mt-8 border-t border-[var(--rule)]">
          <div className="grid gap-1 border-b border-[var(--rule)] py-4 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-sm font-bold">身份适配器</dt>
            <dd className="m-0 text-[var(--emerald-strong)]">{adapterStatus}</dd>
          </div>
          <div className="grid gap-1 border-b border-[var(--rule)] py-4 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-sm font-bold">站内回跳路径</dt>
            <dd className="m-0 font-mono text-sm text-[var(--muted)]">{safeReturnTo}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
