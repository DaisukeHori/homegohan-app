/**
 * #1174 「利用規約・プライバシーポリシーへの同意のお願い」のお知らせ (非ブロッキング)
 *
 * お知らせを有効にしていて (LEGAL_CONSENT_NOTICE=on)、強制 (LEGAL_CONSENT_ENFORCE=on) にしていない間、同意が済んでいない人の
 * 画面の上に出す (既定ではどちらも off なので出ない。フラグの組み合わせは middleware-legal-consent-matrix.test.ts)。
 * 判定は middleware がリクエストヘッダー x-legal-consent-pending で (main) の layout に渡し、layout が MainLayout に渡す。
 * 確認すること:
 *   - お知らせは、同意画面 /legal-consent へのリンク (戻り先 = いま見ているパスとクエリ) を持つ。
 *     戻り先の作り方は、middleware の強制の経路と同じ buildLegalConsentPath (クエリを残し、_rsc は落とす) (#1435)
 *   - 画面の流れの中に置く (固定表示にしない)。ボトムナビ・ヘッダー・モーダルに重ならず、操作を邪魔しない
 *   - (main) の layout は、ヘッダーが '1' のときだけお知らせを出す。MainLayout は、出さない指定なら何も足さない
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  pathname: '/menus/weekly',
  searchParams: new URLSearchParams(),
  /** true なら useSearchParams が読み込み中 (Suspense) になる */
  suspendSearchParams: false,
  headers: new Headers(),
  cookieValue: undefined as string | undefined,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => {
    // 読み込み中: 解決しない Promise を投げて、Suspense の fallback を出させる
    if (mocks.suspendSearchParams) throw new Promise<never>(() => {});
    return mocks.searchParams;
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (mocks.cookieValue ? { value: mocks.cookieValue } : undefined) }),
  headers: () => mocks.headers,
}));

// MainLayout の描画に不要な重い部品・通信は差し替える
vi.mock('@/components/AIChatBubble', () => ({ default: () => null }));
// アイコンは中身を見ない (どの名前でも、何も描かないコンポーネントを返す)
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

const { LegalConsentBanner } = await import('@/components/legal/LegalConsentBanner');
const { buildLegalConsentNext, buildLegalConsentPath } = await import('@/lib/legal-consent');
const { default: MainLayout } = await import('@/app/(main)/MainLayout');

beforeEach(() => {
  mocks.pathname = '/menus/weekly';
  mocks.searchParams = new URLSearchParams();
  mocks.suspendSearchParams = false;
  mocks.headers = new Headers();
  mocks.cookieValue = undefined;
});

describe('LegalConsentBanner', () => {
  function render() {
    document.body.innerHTML = renderToStaticMarkup(<LegalConsentBanner />);
    return document.querySelector('[data-testid="legal-consent-banner"]')!;
  }

  it('同意をお願いする文と、同意画面へのリンクを出す。リンクの戻り先は、いま見ているパス', () => {
    const banner = render();

    expect(banner.textContent).toContain('利用規約・プライバシーポリシー');
    expect(banner.textContent).toContain('同意をお願いします');
    const link = banner.querySelector('a')!;
    expect(link.textContent).toBe('確認して同意する');
    expect(link.getAttribute('href')).toBe('/legal-consent?next=%2Fmenus%2Fweekly');
  });

  it('★いまのクエリも戻り先 (next) に残す (#1435。以前はクエリを落としていた)', () => {
    mocks.searchParams = new URLSearchParams('date=2026-10-08&mode=app');
    const link = render().querySelector('a')!;

    expect(link.getAttribute('href')).toBe('/legal-consent?next=%2Fmenus%2Fweekly%3Fdate%3D2026-10-08%26mode%3Dapp');
    const next = new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('next');
    expect(next).toBe('/menus/weekly?date=2026-10-08&mode=app');
  });

  it('★戻り先の作り方は、middleware の強制の経路 (buildLegalConsentNext) と同じ: RSC の取得 (_rsc) は落とす', () => {
    const search = '?date=2026-10-08&_rsc=abc12';
    mocks.searchParams = new URLSearchParams(search);
    const link = render().querySelector('a')!;

    expect(link.getAttribute('href')).toBe(buildLegalConsentPath('/menus/weekly', search));
    const next = new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('next');
    expect(next).toBe(buildLegalConsentNext('/menus/weekly', search));
    expect(next).toBe('/menus/weekly?date=2026-10-08');
  });

  it('クエリが無ければ、パスだけを戻り先にする', () => {
    mocks.searchParams = new URLSearchParams('');
    expect(render().querySelector('a')!.getAttribute('href')).toBe('/legal-consent?next=%2Fmenus%2Fweekly');
  });

  it('クエリを読めるまで (Suspense の間) も、お知らせとリンク (戻り先 = パスだけ) を出す', () => {
    mocks.suspendSearchParams = true;
    const banner = render();

    expect(banner).not.toBeNull();
    expect(banner.querySelector('a')!.getAttribute('href')).toBe('/legal-consent?next=%2Fmenus%2Fweekly');
  });

  it('パスが取れないときは /home に戻る', () => {
    mocks.pathname = '';
    const link = render().querySelector('a')!;

    expect(link.getAttribute('href')).toBe('/legal-consent?next=%2Fhome');
  });

  it('スクリーンリーダー向けに、領域の名前がある', () => {
    const banner = render();

    expect(banner.getAttribute('role')).toBe('region');
    expect(banner.getAttribute('aria-label')).toContain('同意');
  });

  it('★画面の流れの中に置く: 固定・絶対・sticky 表示にしない (ボトムナビ・ヘッダー・モーダルに重ならない)', () => {
    const classes = (render().getAttribute('class') ?? '').split(/\s+/);

    for (const positioned of ['fixed', 'absolute', 'sticky']) {
      expect(classes, `${positioned} を使っていない`).not.toContain(positioned);
    }
    expect(classes.some((c) => /^(?:top|bottom|left|right|z)-/.test(c)), 'top-* / bottom-* / z-* を使っていない').toBe(false);
  });

  it('role="alert" ではない (ほかの画面の alert の検査や、読み上げを邪魔しない)', () => {
    const banner = render();

    expect(banner.getAttribute('role')).not.toBe('alert');
    expect(banner.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('MainLayout: お知らせの出し分け', () => {
  function render(props: { legalConsentPending?: boolean } = {}) {
    document.body.innerHTML = renderToStaticMarkup(
      <MainLayout {...props}>
        <div data-testid="page-content">ページの中身</div>
      </MainLayout>,
    );
  }

  it('legalConsentPending が true なら、<main> の先頭 (ページの中身より前) にお知らせを出す', () => {
    render({ legalConsentPending: true });

    const main = document.querySelector('main')!;
    const banner = main.querySelector('[data-testid="legal-consent-banner"]');
    const content = main.querySelector('[data-testid="page-content"]');
    expect(banner).not.toBeNull();
    expect(content).not.toBeNull();
    // 先頭の子要素がお知らせ
    expect(main.firstElementChild).toBe(banner);
    expect(banner!.compareDocumentPosition(content!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([undefined, false])('legalConsentPending が %s なら、何も足さない', (value) => {
    render(value === undefined ? {} : { legalConsentPending: value });

    expect(document.querySelector('[data-testid="legal-consent-banner"]')).toBeNull();
    expect(document.querySelector('main [data-testid="page-content"]')).not.toBeNull();
  });
});

describe('(main) の layout: middleware のヘッダーを MainLayout に渡す', () => {
  async function renderLayout() {
    const { default: Layout } = await import('@/app/(main)/layout');
    const element = await Layout({ children: <div data-testid="page-content" /> });
    document.body.innerHTML = renderToStaticMarkup(element);
    return element;
  }

  it("x-legal-consent-pending が '1' のときだけ、お知らせを出す", async () => {
    mocks.headers = new Headers({ 'x-legal-consent-pending': '1' });
    await renderLayout();

    expect(document.querySelector('[data-testid="legal-consent-banner"]')).not.toBeNull();
  });

  it.each([[undefined], ['0'], ['true'], ['']])('ヘッダーが %j なら、お知らせを出さない', async (value) => {
    mocks.headers = value === undefined ? new Headers() : new Headers({ 'x-legal-consent-pending': value });
    await renderLayout();

    expect(document.querySelector('[data-testid="legal-consent-banner"]')).toBeNull();
    expect(document.querySelector('[data-testid="page-content"]')).not.toBeNull();
  });

  it('native アプリの判定 (is_native_app の Cookie) は従来どおり MainLayout に渡す', async () => {
    mocks.cookieValue = '1';
    const element = await renderLayout();

    expect((element as { props: { initialIsNativeApp: boolean } }).props.initialIsNativeApp).toBe(true);
  });
});
