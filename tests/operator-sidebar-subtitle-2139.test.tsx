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
 *
 * #2150 Q3-1: 運営・サポートの画面に英字だけの文が 3 か所残っていた。
 *   - サポートの画面のサイドバーの下の自分の名前: nickname が空のときに「👤 Support」と出ていた → 「サポート担当」
 *   - 売上ダッシュボード (/admin/finance) の副題が「Finance」→「売上と課金」
 *   - NPS の画面 (/admin/finance/nps) の副題が「Net Promoter Score & Customer Satisfaction」→「推奨度 (NPS) と満足度 (CSAT)」
 *     (見出しの略語「NPS / CSAT」はそのまま)
 *   この 3 か所が英字だけの文に戻らないことを、同じ英字だけの判定で見張る
 *
 * #2150 Q3b-1: NPS の画面の節の見出し (h2) 2 つが英字だけの「NPS (Net Promoter Score)」「CSAT (Customer Satisfaction)」だった。
 *   上の見張りは画面の見出し (h1) と副題だけを見ており、英字だけの判定も括弧を含む文を英字だけとみなさなかったので拾わなかった。
 *   直したあとは「推奨度 (NPS)」「満足度 (CSAT)」(h1 の副題「推奨度 (NPS) と満足度 (CSAT)」に合わせる)。
 *   売上と NPS の画面の見張りを画面の h1〜h6 すべてに広げ、英字だけの判定も括弧つきの英字の文を拾うように直す
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
// nickname はテストごとに変える (名前が無いときの呼び名を確かめる。#2150 Q3-1)。既定はサポートの人の名前がある
const SUPPORT_DEFAULT_NICKNAME = 'サポートの人';
const supportProfile = vi.hoisted(() => ({ nickname: 'サポートの人' as string | null }));
const supportClient = vi.hoisted(() => {
  const profileQuery = {
    select: () => profileQuery,
    eq: () => profileQuery,
    single: async () => ({ data: { roles: ['support'], nickname: supportProfile.nickname }, error: null }),
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
const { default: FinanceDashboardPage } = await import('@/app/admin/finance/page');
const { default: NpsPage } = await import('@/app/admin/finance/nps/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 運営最上位の画面と緊急介入の画面のサイドバーの副題 (運営の画面の共通の呼び名) */
const OPERATOR_SIDEBAR_SUBTITLE = 'ほめゴハン 運営';

/**
 * 環境の札の文 (src/app/admin/layout.tsx の envBadge・super-admin と operator/membership の環境バッジ)。
 * 運用の略号で見出し・副題ではないので数えない
 */
const ENV_BADGE_LABELS: ReadonlySet<string> = new Set(['PROD', 'STAGING', 'PREVIEW', 'LOCAL / STAGING']);

/**
 * 英字だけの文 (2 文字以上で、英字で始まり英字か閉じ括弧で終わり、間は英字・空白・記号・括弧だけ。日本語を 1 文字も含まない)。
 * 括弧つきの英字の文 (以前の NPS の画面の h2「NPS (Net Promoter Score)」) も英字だけと判定する。
 * 以前は括弧を許しておらず、この形を見逃していた (#2150 Q3b-1)
 */
const ENGLISH_ONLY_TEXT = /^[A-Za-z][A-Za-z\s./&()-]*[A-Za-z)]$/;

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
    // 括弧つきの英字の文も英字だけ。括弧の中だけが英字で、外に日本語がある文は数えない (#2150 Q3b-1)
    expect(isEnglishOnlyText('NPS (Net Promoter Score)')).toBe(true);
    expect(isEnglishOnlyText('推奨度 (NPS)')).toBe(false);
  });

  it.each(OPERATOR_LAYOUTS)('$name のサイドバーの上の見出し・副題に英字だけの文が無い', async ({ mount }) => {
    await mount();
    const texts = sidebarHeaderTexts().filter((text) => !ENV_BADGE_LABELS.has(text));
    // 見出しを取れている (セレクタの書き誤りで空振りしない)
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter(isEnglishOnlyText)).toEqual([]);
  });
});

// ─── #2150 Q3-1: サポートの画面の自分の名前・売上と NPS の画面の副題 ─────────────────────────

afterEach(() => {
  supportProfile.nickname = SUPPORT_DEFAULT_NICKNAME;
  vi.unstubAllGlobals();
});

/** サポートの画面のサイドバーの下の自分の名前 (👤 の横)。nickname が空のときの呼び名 */
const SUPPORT_USER_NAME_FALLBACK = 'サポート担当';

/** サイドバーの下の自分の名前の欄の文 (👤 を除く) */
function supportUserNameText(): string {
  const cell = Array.from(document.querySelectorAll('aside div')).find(
    (el) => el.children.length === 0 && (el.textContent ?? '').trim().startsWith('👤'),
  );
  if (!cell) throw new Error('サイドバーに自分の名前の欄がありません');
  return (cell.textContent ?? '').replace('👤', '').trim();
}

describe('サポートの画面 (/support) のサイドバーの自分の名前 (#2150 Q3-1)', () => {
  it('nickname があればそのまま出す', async () => {
    await mountSupportLayout();
    expect(supportUserNameText()).toBe(SUPPORT_DEFAULT_NICKNAME);
  });

  // 空・空白だけ・仮置きの名前 (Guest) は normalizeProfileName が「名前が無い」とみなす
  it.each([
    { label: 'null', nickname: null },
    { label: '空文字', nickname: '' },
    { label: '空白だけ', nickname: '   ' },
    { label: '仮置きの Guest', nickname: 'Guest' },
  ])('nickname が $label のときは「サポート担当」と出し、英字だけの Support は出さない', async ({ nickname }) => {
    supportProfile.nickname = nickname;
    await mountSupportLayout();
    const name = supportUserNameText();
    expect(name).toBe(SUPPORT_USER_NAME_FALLBACK);
    expect(isEnglishOnlyText(name)).toBe(false);
    expect(document.querySelector('aside')?.textContent).not.toContain('Support');
  });
});

/** 画面の見出しのうち、運用の略語として英字のまま出してよいもの (NPS の画面の見出し) */
const PAGE_HEADING_ABBREVIATIONS: ReadonlySet<string> = new Set(['NPS / CSAT']);

/**
 * クライアントの画面の読み込み (fetch → 本文の読み込み → 状態の更新) を流し切るために act で待つ回数。
 * 読み込みは await 数回で終わる。NPS の画面は読み込み中も見出しを出すので、見出しが出た時点では止めず、毎回この回数だけ待つ
 */
const CLIENT_PAGE_FLUSHES = 10;

/** パスごとの応答で fetch を置き換え、クライアントの画面を描いて見出しが出たあとの HTML を document.body に置く */
async function mountClientPage(Page: () => ReactElement, routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (!(path in routes)) throw new Error(`想定外の呼び出し: ${path}`);
      return new Response(JSON.stringify(routes[path]), { headers: { 'content-type': 'application/json' } });
    }),
  );
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Page));
  });
  for (let flush = 0; flush < CLIENT_PAGE_FLUSHES; flush += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = html;
}

/**
 * 画面の見出しの要素 (h1〜h6) すべての文 (出てくる順)。
 * 画面の上の見出し (h1) だけでなく、節の見出し (h2 など) も英字だけの文を見張る (#2150 Q3b-1)
 */
function pageHeadingTexts(): string[] {
  return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

/** 画面の上の見出し (h1) と、同じ区画の副題 (p) の文 */
function pageHeaderTexts(): { heading: string; subtitle: string } {
  const heading = document.querySelector('h1');
  if (!heading) throw new Error('画面に見出しがありません');
  const subtitle = heading.parentElement?.querySelector(':scope > p');
  if (!subtitle) throw new Error('見出しの区画に副題がありません');
  return { heading: heading.textContent?.trim() ?? '', subtitle: subtitle.textContent?.trim() ?? '' };
}

/** 売上ダッシュボードの API の応答 (見出しを出すのに要る形だけ。値は本題ではない) */
const FINANCE_ROUTES = {
  '/api/admin/finance/dashboard': {
    data: {
      current_mrr_jpy: 0,
      current_arr_jpy: 0,
      churn_rate: 0,
      ltv_jpy: 0,
      new_mrr_jpy: 0,
      expansion_mrr_jpy: 0,
      contraction_mrr_jpy: 0,
      churned_mrr_jpy: 0,
      personal_active_users: 0,
      family_active_groups: 0,
      org_active_orgs: 0,
      mau: 0,
    },
  },
  '/api/admin/finance/exports': { data: { available_types: ['revenue'] } },
};

/** NPS の画面の API の応答 (最近のコメントの節の見出しも出すよう、コメントを 1 件入れる) */
const NPS_ROUTES = {
  '/api/admin/finance/nps': {
    data: {
      nps: {
        total_responses: 0,
        promoters: 0,
        passives: 0,
        detractors: 0,
        nps_score: 0,
        avg_score: 0,
        response_rate: 0,
        recent_comments: [{ id: 'nps-comment-1', score: 0, comment: 'テストのコメント', plan_key: null, responded_at: null }],
      },
      csat: { total_responses: 0, avg_score: 0, score_distribution: {}, recent_feedbacks: [] },
    },
  },
};

const FINANCE_PAGES: ReadonlyArray<{
  name: string;
  Page: () => ReactElement;
  routes: Record<string, unknown>;
  heading: string;
  subtitle: string;
  englishSubtitle: string;
  /** 画面の h1〜h6 の文 (出てくる順) */
  headings: readonly string[];
  /** 以前の英字だけの節の見出し (#2150 Q3b-1) */
  englishHeadings: readonly string[];
}> = [
  {
    name: 'src/app/admin/finance/page.tsx',
    Page: FinanceDashboardPage,
    routes: FINANCE_ROUTES,
    heading: '売上ダッシュボード',
    subtitle: '売上と課金',
    englishSubtitle: 'Finance',
    headings: ['売上ダッシュボード', 'ユーザー数'],
    englishHeadings: [],
  },
  {
    name: 'src/app/admin/finance/nps/page.tsx',
    Page: NpsPage,
    routes: NPS_ROUTES,
    heading: 'NPS / CSAT',
    subtitle: '推奨度 (NPS) と満足度 (CSAT)',
    englishSubtitle: 'Net Promoter Score & Customer Satisfaction',
    headings: ['NPS / CSAT', '推奨度 (NPS)', '満足度 (CSAT)', '最近の NPS コメント'],
    englishHeadings: ['NPS (Net Promoter Score)', 'CSAT (Customer Satisfaction)'],
  },
];

describe('売上と NPS の画面の見出し・副題に英字だけの文が無い (#2150 Q3-1)', () => {
  it('判定が機能している: 以前の英字だけの副題を検出する', () => {
    for (const { englishSubtitle } of FINANCE_PAGES) expect(isEnglishOnlyText(englishSubtitle)).toBe(true);
    // 以前の英字だけの節の見出し (括弧つき) も検出する (#2150 Q3b-1)
    for (const { englishHeadings } of FINANCE_PAGES) {
      for (const englishHeading of englishHeadings) expect(isEnglishOnlyText(englishHeading)).toBe(true);
    }
    // 見出しの略語も英字だけなので、許す略語として明示して外す (判定から漏れているのではない)
    for (const abbreviation of PAGE_HEADING_ABBREVIATIONS) expect(isEnglishOnlyText(abbreviation)).toBe(true);
  });

  it.each(FINANCE_PAGES)('$name: 見出しと副題は日本語 (英字の副題は出さない)', async ({ Page, routes, heading, subtitle, englishSubtitle }) => {
    await mountClientPage(Page, routes);
    const texts = pageHeaderTexts();
    expect(texts).toEqual({ heading, subtitle });
    expect(isEnglishOnlyText(texts.subtitle)).toBe(false);
    expect([texts.heading, texts.subtitle].filter((text) => isEnglishOnlyText(text) && !PAGE_HEADING_ABBREVIATIONS.has(text))).toEqual([]);
    expect(document.body.textContent).not.toContain(englishSubtitle);
  });

  it.each(FINANCE_PAGES)('$name: 画面の h1〜h6 すべてに英字だけの文が無い (#2150 Q3b-1)', async ({ Page, routes, headings, englishHeadings }) => {
    await mountClientPage(Page, routes);
    const texts = pageHeadingTexts();
    expect(texts.filter((text) => isEnglishOnlyText(text) && !PAGE_HEADING_ABBREVIATIONS.has(text))).toEqual([]);
    // 見出しを全部取れている (セレクタの書き誤り・読み込みの待ち不足で空振りしない)
    expect(texts).toEqual(headings);
    for (const englishHeading of englishHeadings) expect(document.body.textContent).not.toContain(englishHeading);
  });
});
