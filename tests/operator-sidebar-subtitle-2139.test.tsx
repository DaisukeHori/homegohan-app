/**
 * #2139 T2: 運営の画面のサイドバーの見出し・副題に、英字だけの文を出さない
 *
 * 以前の問題:
 *   - 緊急介入の画面 (/operator/membership) のサイドバーの副題が英字の「Membership Admin」だった。
 *     運営最上位の画面 (/super-admin) の同じ位置は「ほめゴハン 運営」で、画面の間で呼び方がそろっていなかった。
 *     #2128 の走査 (tests/admin-sidebar-role-labels-2128.test.tsx) は旧いロールの呼び名だけを見るので拾わなかった
 *
 * 確かめること:
 *   - /operator/membership のサイドバーの見出しは「緊急介入」、副題は「ほめゴハン 運営」(/super-admin の副題と同じ)
 *   - 同じ型: 運営の画面のレイアウト (/admin・/super-admin・/operator/membership・サポートの画面 (/support)) のサイドバーの
 *     上の見出し・副題に、英字だけの文が無い。環境の札 (PROD など。運用の略号) とロゴの 1 文字は見出し・副題ではないので数えない
 *
 * #2144 S2: サポートの画面 (src/app/(support)/layout.tsx) のサイドバーの見出しが英字だけの「Support Center」、副題が「ほめゴハン」だった。
 *   このレイアウトは上の見張りの対象に入っておらず、見出しは h1 で見張りのセレクタ (p・span) にも入っていなかった。
 *   直したあとは見出し「サポートセンター」、副題「ほめゴハン 運営」とし、見張りの対象と見出しの要素 (h1〜h6) を足す
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// 本物の useRouter は同じ参照を返す (毎回作るとサポートの画面の useEffect の依存が変わって読み込みが繰り返し走る)
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/support',
}));

// サポートの画面 ("use client") は開いたあとに自分とプロフィールを読み、権限があればサイドバーを出す。
// 読み込みはこのテストの対象ではないので、ログインしていてサポートの権限がある結果だけを返す
const supportClient = vi.hoisted(() => {
  const profileQuery = {
    select: () => profileQuery,
    eq: () => profileQuery,
    single: async () => ({ data: { roles: ['support'], nickname: 'サポートの人' }, error: null }),
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'support-1', email: 'support@example.com' } }, error: null }),
    },
    from: () => profileQuery,
  };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: () => supportClient }));

// ロールの判定 (Supabase・MFA) はこのテストの対象ではないので、通った結果だけを返す (super_admin は 3 つの画面すべてに入れる)
vi.mock('@/lib/auth/page-guard', () => ({
  requireRoleForPage: async () => ({
    id: 'operator-1',
    email: 'operator@example.com',
    roles: ['super_admin'],
    assurance: null,
  }),
}));

const { default: AdminLayout } = await import('@/app/admin/layout');
const { default: SuperAdminLayout } = await import('@/app/super-admin/layout');
const { default: OperatorMembershipLayout } = await import('@/app/(operator)/operator/membership/layout');
const { default: SupportLayout } = await import('@/app/(support)/layout');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 運営最上位の画面と緊急介入の画面のサイドバーの副題 (運営の画面の共通の呼び名) */
const OPERATOR_SIDEBAR_SUBTITLE = 'ほめゴハン 運営';

/**
 * 環境の札の文 (src/app/admin/layout.tsx の envBadge・super-admin と operator/membership の環境バッジ)。
 * 運用の略号で見出し・副題ではないので数えない
 */
const ENV_BADGE_LABELS: ReadonlySet<string> = new Set(['PROD', 'STAGING', 'PREVIEW', 'LOCAL / STAGING']);

/** 英字だけの文 (2 文字以上の英字で始まり英字で終わり、間は英字・空白・記号だけ。日本語を 1 文字も含まない) */
const ENGLISH_ONLY_TEXT = /^[A-Za-z][A-Za-z\s./&-]*[A-Za-z]$/;

function isEnglishOnlyText(text: string): boolean {
  return ENGLISH_ONLY_TEXT.test(text.trim());
}

type LayoutComponent = (props: { children: ReactNode }) => Promise<ReactElement>;

async function mountLayout(Layout: LayoutComponent) {
  document.body.innerHTML = renderToStaticMarkup(await Layout({ children: <p id="page-body">本文</p> }));
}

/**
 * サポートの画面の読み込み (getUser → プロフィール → 状態の更新) を流し切るまでに、act で待つ回数の上限。
 * 読み込みは await 2 回と状態の更新だけなので数回で終わる。上限はサイドバーが出ないときにテストを止めるための余裕
 */
const SUPPORT_LAYOUT_MAX_FLUSHES = 10;

/**
 * サポートの画面 ("use client") を描画し、読み込みが終わってサイドバーが出たあとの HTML を document.body に置く。
 * サーバーの描画 (renderToStaticMarkup) では読み込み中の表示しか出ないので、ブラウザと同じく描画して待つ
 */
async function mountSupportLayout() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SupportLayout, null, <p id="page-body">本文</p>));
  });
  for (let flush = 0; flush < SUPPORT_LAYOUT_MAX_FLUSHES && !container.querySelector('aside'); flush += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = html;
}

const OPERATOR_LAYOUTS: ReadonlyArray<{ name: string; mount: () => Promise<void> }> = [
  { name: 'src/app/admin/layout.tsx', mount: () => mountLayout(AdminLayout as LayoutComponent) },
  { name: 'src/app/super-admin/layout.tsx', mount: () => mountLayout(SuperAdminLayout as LayoutComponent) },
  {
    name: 'src/app/(operator)/operator/membership/layout.tsx',
    mount: () => mountLayout(OperatorMembershipLayout as LayoutComponent),
  },
  { name: 'src/app/(support)/layout.tsx', mount: mountSupportLayout },
];

/**
 * サイドバーの上の区画 (ロゴ・見出し・副題) の文。ロゴは div の 1 文字なので入らない。
 * 見出しを h1 などで書いた画面 (サポートの画面) も数えるよう、見出しの要素も入れる (#2144 S2)
 */
function sidebarHeaderTexts(): string[] {
  return Array.from(document.querySelectorAll('aside > div:first-child :is(h1, h2, h3, h4, h5, h6, p, span)'))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

describe('/operator/membership のサイドバーの見出しと副題 (#2139 T2)', () => {
  it('見出しは「緊急介入」、副題は「ほめゴハン 運営」で、英字の Membership Admin は出さない', async () => {
    await mountLayout(OperatorMembershipLayout as LayoutComponent);
    expect(sidebarHeaderTexts()).toEqual(['緊急介入', OPERATOR_SIDEBAR_SUBTITLE]);
    expect(document.querySelector('aside')?.textContent).not.toContain('Membership Admin');
  });

  it('副題は運営最上位の画面 (/super-admin) の同じ位置の副題と同じ', async () => {
    await mountLayout(SuperAdminLayout as LayoutComponent);
    const superAdminSubtitle = sidebarHeaderTexts()[1];
    await mountLayout(OperatorMembershipLayout as LayoutComponent);
    expect(sidebarHeaderTexts()[1]).toBe(superAdminSubtitle);
    expect(superAdminSubtitle).toBe(OPERATOR_SIDEBAR_SUBTITLE);
  });
});

describe('サポートの画面 (/support) のサイドバーの見出しと副題 (#2144 S2)', () => {
  it('見出しは「サポートセンター」、副題は「ほめゴハン 運営」で、英字の Support Center は出さない', async () => {
    await mountSupportLayout();
    expect(sidebarHeaderTexts()).toEqual(['サポートセンター', OPERATOR_SIDEBAR_SUBTITLE]);
    expect(document.querySelector('aside')?.textContent).not.toContain('Support Center');
  });

  it('副題は運営最上位の画面 (/super-admin) の同じ位置の副題と同じ', async () => {
    await mountLayout(SuperAdminLayout as LayoutComponent);
    const superAdminSubtitle = sidebarHeaderTexts()[1];
    await mountSupportLayout();
    expect(sidebarHeaderTexts()[1]).toBe(superAdminSubtitle);
  });
});

describe('同じ型: 運営の画面のレイアウトのサイドバーの見出し・副題に英字だけの文が無い (#2139 T2)', () => {
  it('判定が機能している: 英字だけの文を検出し、日本語を含む文・ロゴの 1 文字は数えない', () => {
    expect(isEnglishOnlyText('Membership Admin')).toBe(true);
    expect(isEnglishOnlyText('Super Admin')).toBe(true);
    expect(isEnglishOnlyText('Operator')).toBe(true);
    expect(isEnglishOnlyText('Support Center')).toBe(true);
    expect(isEnglishOnlyText(OPERATOR_SIDEBAR_SUBTITLE)).toBe(false);
    expect(isEnglishOnlyText('緊急介入')).toBe(false);
    expect(isEnglishOnlyText('inactive owner 検索')).toBe(false);
    expect(isEnglishOnlyText('M')).toBe(false);
  });

  it.each(OPERATOR_LAYOUTS)('$name のサイドバーの上の見出し・副題に英字だけの文が無い', async ({ mount }) => {
    await mount();
    const texts = sidebarHeaderTexts().filter((text) => !ENV_BADGE_LABELS.has(text));
    // 見出しを取れている (セレクタの書き誤りで空振りしない)
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter(isEnglishOnlyText)).toEqual([]);
  });
});
