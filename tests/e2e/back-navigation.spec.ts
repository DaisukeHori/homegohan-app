/**
 * #1867 ブラウザの「戻る / 進む」で、ハッシュつきの URL (/#how など) へ戻ったときに画面が切り替わること。
 *
 * 不具合: `/` → ヘッダーの「使い方」(<a href="#how">) → 「無料で始める」(next/link の /signup) → 戻る で、URL だけ `/#how` に戻り、
 * 画面は /signup のまま残った。ブラウザの通常のハッシュの移動は history.state = null の項目を積み、Next の app router は
 * state が null の項目の popstate を無視するため (原因と直し方: src/lib/navigation/hash-history-entry.ts)。
 *
 * 確かめる型:
 *   - 紹介ページのヘッダーの全部のハッシュ (LANDING_COPY.header.nav) → /signup → 戻る
 *   - ハッシュ → 他の公開ページ (/login・/pricing・/guide。フッターの next/link) → 戻る
 *   - ハッシュ無しの `/` → /signup → 戻る (直す前から動いていた対照)
 *   - 戻ったあとの進む (/signup に戻る)
 *   - 紹介ページ以外のハッシュ (スキップリンクの #main-content。/pricing) → /signup → 戻る
 *   - 検索の部分の書き方が画面と URL で違う `/` (広告の流入の %20・値の無いキー) で、ハッシュ → ハッシュ → 戻る が読み込み直さない
 * 同じ文書の中で戻る型は、画面が正しいことに加えて、読み込み直していない (文書の load が 0 回・window に置いた印が残っている) ことも確かめる
 * (部品の印付けが効かず、保険の読み込み直しで画面が直った場合も赤にするため)。
 * 読み込み直すのが正しい型は、最後の describe に分けて置く:
 *   - ハッシュ → 通常の文書の遷移 (page.goto) で /signup → 戻る (別の文書へ戻るので、紹介ページの文書を読み込む)
 *   - 印を付ける前に積まれた項目 (state が null のまま) → /signup → 戻る (部品が今の URL で読み込み直す)
 * 検査の手がかりは、URL・セクションの id (ハッシュと同じ)・見出し・LANDING_COPY の文言だけ (紹介ページの見た目や文言の作り直しに引きずられない)。
 */
import { expect, test, type Page } from '@playwright/test';
import { LANDING_COPY } from '../../src/components/marketing/landing-copy';

// playwright.config.ts の共有ログイン状態 (storageState) を引き継がず、未ログインで確かめる (ログイン済みだと /signup・/login から振り分けられる)
test.use({ storageState: { cookies: [], origins: [] } });

/** dev サーバの初回コンパイルや遅い機械を待てるよう、画面遷移直後の可視性アサーションだけ長めにする (landing-page.spec.ts と同じ値) */
const NAVIGATION_TIMEOUT = 30_000;
/** 登録の画面の見出し (src/app/(auth)/signup/page.tsx の h1) */
const SIGNUP_HEADING = 'アカウント作成';
/** ログインの画面の見出し (src/app/(auth)/login/page.tsx の h1) */
const LOGIN_HEADING = 'おかえりなさい';
/** 料金の画面の見出し (src/app/pricing/PricingPageView.tsx の h1) */
const PRICING_HEADING = /料金プラン/;
/** 使い方ガイドの画面の見出し (src/app/guide/page.tsx の h1) */
const GUIDE_HEADING = /使い方ガイド/;
/** ルートの layout のスキップリンクの飛び先 (src/app/layout.tsx) */
const SKIP_LINK_HASH = '#main-content';

/** 紹介ページのヘッダーのハッシュのリンク (#features・#how・#badges・#faq) */
const HEADER_HASH_LINKS = LANDING_COPY.header.nav.filter((item) => item.href.startsWith('#'));
/** ハッシュから他の公開ページへ移って戻る型に使うハッシュ (オーナーの報告の #how) */
const REPORTED_HASH = '#how';

/**
 * URL に書かれたままの形と、URLSearchParams で書き直した形が違う検索の部分 (広告の流入の %20・値の無いキー)。
 * 画面側 (useSearchParams) と URL 側 (window.location.search) の書き方の違いで、同じ画面を「別のルート」と取り違えないこと
 */
const NON_CANONICAL_SEARCHES = ['?utm_campaign=a%20b', '?ref'] as const;
/** 読み込み直しが起きていないことを見るため、文書に置く印の名前 (読み込み直すと消える) */
const DOCUMENT_MARKER = '__backNavigationDocumentMarker';

/** 読み込み直しの見張り (見張りを始めてからの文書の load の回数と、始めたときに文書に置いた印) */
type DocumentReloadWatch = {
  /** 見張りを始めてから、文書の load が起きた回数 (読み込み直すと起きる。戻るの後に始まる読み込み直しも数える) */
  loadCount: () => number;
  /** 見張りを始めたときに置いた印が、今の文書に残っているか (読み込み直すと文書が作り直され、印が消える) */
  markerSurvives: () => Promise<boolean>;
};

/** 今の文書に印を置き、以後の文書の load を数え始める */
async function watchDocumentReloads(page: Page): Promise<DocumentReloadWatch> {
  await page.evaluate((marker) => Reflect.set(window, marker, true), DOCUMENT_MARKER);
  let documentLoads = 0;
  page.on('load', () => {
    documentLoads += 1;
  });
  return {
    loadCount: () => documentLoads,
    markerSurvives: () => page.evaluate((marker) => Reflect.get(window, marker) === true, DOCUMENT_MARKER),
  };
}

/**
 * 見張りを始めてから読み込み直していないこと。画面の検査の後に呼ぶ
 * (印付けが効かずに保険の読み込み直しで直る場合、前の画面が消えるのは読み込み直しの後なので、画面の検査を通った時点で load が数えられている)
 */
async function expectNoDocumentReload(watch: DocumentReloadWatch): Promise<void> {
  expect(watch.loadCount()).toBe(0);
  expect(await watch.markerSurvives()).toBe(true);
}

/**
 * 描画の後の effect が済むまで待つ (次の描画のフレームの後の 1 つのタスク)。
 * 部品 (HashHistoryEntryBridge) は、いま描かれているルートを描画の後の effect で受け取る。画面が見えた直後 (同じフレームの中) に戻ると、
 * 部品はまだ前のルートを持っていて、印の無い項目へ戻ったことに気付けない (WebKit で再現。人の操作では起きない間合い)
 */
async function waitForEffectsAfterPaint(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))),
  );
}

/** 紹介ページを開き、ハイドレーションが済むのを待つ (ヘッダーのリンクを押せる状態) */
async function openLanding(page: Page, search = ''): Promise<void> {
  await page.goto(`/${search}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await page.waitForLoadState('networkidle');
}

/** 正規表現の中で文字どおりに扱う (検索の部分の ? など) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ヘッダーのハッシュのリンクを押し、URL が (検索の部分はそのままで) そのハッシュになり、その区切りが画面に入るまで待つ */
async function clickHeaderHash(page: Page, hash: string, search = ''): Promise<void> {
  await page.getByRole('navigation', { name: 'サイトの案内' }).locator(`a[href="${hash}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/${escapeRegExp(search)}${hash}$`));
  await expect(page.locator(hash)).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
}

/** ヘッダーの「無料で始める」(next/link) で登録の画面へ移る */
async function goToSignupFromHeader(page: Page): Promise<void> {
  await page.getByRole('banner').getByRole('link', { name: LANDING_COPY.header.cta.label }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
}

/** 紹介ページの hash の区切りへ戻っていること (URL・区切りが画面に入っている・登録の画面が残っていない) */
async function expectBackOnLandingSection(page: Page, hash: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/${hash}$`));
  await expect(page.locator(hash)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await expect(page.locator(hash)).toBeInViewport();
  await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toHaveCount(0);
}

test.describe('#1867 戻る / 進む で、ハッシュつきの URL の画面へ戻る', () => {
  for (const item of HEADER_HASH_LINKS) {
    test(`/ → ${item.href} (${item.label}) → /signup → 戻る で、紹介ページの ${item.href} が見えている`, async ({ page }) => {
      await openLanding(page);
      const watch = await watchDocumentReloads(page);
      await clickHeaderHash(page, item.href);
      await goToSignupFromHeader(page);

      await page.goBack();

      await expectBackOnLandingSection(page, item.href);
      await expectNoDocumentReload(watch);
    });
  }

  test('/ → #how → /signup → 戻る → 進む で、登録の画面に戻る', async ({ page }) => {
    await openLanding(page);
    const watch = await watchDocumentReloads(page);
    await clickHeaderHash(page, REPORTED_HASH);
    await goToSignupFromHeader(page);
    await page.goBack();
    await expectBackOnLandingSection(page, REPORTED_HASH);

    await page.goForward();

    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.locator(REPORTED_HASH)).toHaveCount(0);
    await expectNoDocumentReload(watch);
  });

  test('/ → #how → #faq → /signup → 戻る 2 回 で、#faq → #how の順に戻る', async ({ page }) => {
    await openLanding(page);
    const watch = await watchDocumentReloads(page);
    await clickHeaderHash(page, REPORTED_HASH);
    await clickHeaderHash(page, '#faq');
    await goToSignupFromHeader(page);

    await page.goBack();
    await expectBackOnLandingSection(page, '#faq');

    await page.goBack();
    await expectBackOnLandingSection(page, REPORTED_HASH);
    await expectNoDocumentReload(watch);
  });

  const OTHER_PUBLIC_PAGES = [
    { label: 'ログイン', path: '/login', heading: LOGIN_HEADING },
    { label: '料金プラン', path: '/pricing', heading: PRICING_HEADING },
    { label: '使い方ガイド', path: '/guide', heading: GUIDE_HEADING },
  ] as const;
  for (const target of OTHER_PUBLIC_PAGES) {
    test(`/ → #how → ${target.path} (フッターの「${target.label}」) → 戻る で、紹介ページの #how が見えている`, async ({ page }) => {
      await openLanding(page);
      const watch = await watchDocumentReloads(page);
      await clickHeaderHash(page, REPORTED_HASH);
      await page.getByRole('contentinfo').getByRole('link', { name: target.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${target.path}$`));
      await expect(page.getByRole('heading', { level: 1, name: target.heading })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

      await page.goBack();

      // フッターを押した時点のスクロールはページの末尾なので、戻ったあとのスクロールの位置 (末尾に戻すか #how か) はブラウザで違う
      // (WebKit は末尾に戻す)。ここで確かめるのは、紹介ページが描かれ (#how の区切りがある)、前の画面が残っていないこと
      await expect(page).toHaveURL(new RegExp(`/${REPORTED_HASH}$`));
      await expect(page.locator(REPORTED_HASH)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await expect(page.getByRole('heading', { level: 1, name: target.heading })).toHaveCount(0);
      await expectNoDocumentReload(watch);
    });
  }

  test('ハッシュ無しの / → /signup → 戻る で、紹介ページの先頭に戻る (対照)', async ({ page }) => {
    await openLanding(page);
    const watch = await watchDocumentReloads(page);
    await goToSignupFromHeader(page);

    await page.goBack();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toHaveCount(0);
    await expect(page.locator('#hero')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    await expectNoDocumentReload(watch);
  });

  // 文書の遷移で /signup を開く型より前に置く (src/__tests__/config/e2e-auth-page-wait.test.ts は、goto("/signup") から次の画面の移動までの行の networkidle 待ちを
  // 登録の画面での待ちとみなす。ここでの networkidle は紹介ページでの待ち)
  for (const search of NON_CANONICAL_SEARCHES) {
    test(`/${search} → #how → #faq → 戻る で、読み込み直さずに #how へ戻る (検索の部分の書き方の違いで取り違えない)`, async ({ page }) => {
      await openLanding(page, search);
      const watch = await watchDocumentReloads(page);
      await clickHeaderHash(page, REPORTED_HASH, search);
      await clickHeaderHash(page, '#faq', search);

      await page.goBack();
      await page.waitForLoadState('networkidle');

      await expect(page).toHaveURL(new RegExp(`/${escapeRegExp(search)}${REPORTED_HASH}$`));
      await expect(page.locator(REPORTED_HASH)).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
      await expectNoDocumentReload(watch);
    });
  }

  test('/pricing でスキップリンク (#main-content) → /signup → 戻る で、料金の画面に戻る (紹介ページ以外のハッシュ)', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1, name: PRICING_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await page.waitForLoadState('networkidle');
    const watch = await watchDocumentReloads(page);
    await page.locator(`a[href="${SKIP_LINK_HASH}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/pricing${SKIP_LINK_HASH}$`));
    // 料金の画面のヘッダーの「無料で始める」(next/link の /signup)
    await page.locator('a[href="/signup"]').first().click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    await page.goBack();

    await expect(page).toHaveURL(new RegExp(`/pricing${SKIP_LINK_HASH}$`));
    await expect(page.getByRole('heading', { level: 1, name: PRICING_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toHaveCount(0);
    await expectNoDocumentReload(watch);
  });
});

// 読み込み直すのが正しい型 (上の型と違い、読み込み直していないことは確かめない。読み込んだ後の画面が正しいことを確かめる)
test.describe('#1867 戻る で文書を読み込むのが正しい型 (別の文書へ戻る・印を付ける前に積まれた項目へ戻る)', () => {
  test('/ → #how → 文書の遷移 (アドレス欄で /signup を開く) → 戻る で、紹介ページの文書を読み込み、#how が見えている (別の文書へ戻る型)', async ({ page }) => {
    // 戻るは /signup の文書から紹介ページの文書への移動なので、紹介ページの文書の load が起きる (部品の読み込み直しではない)
    await openLanding(page);
    await clickHeaderHash(page, REPORTED_HASH);
    await page.goto('/signup');
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });

    await page.goBack();

    await expectBackOnLandingSection(page, REPORTED_HASH);
  });

  test('/ → 印を付ける前に積まれた #how (state が null のまま) → /signup → 戻る で、読み込み直して紹介ページを描く (保険の読み込み直し)', async ({ page }) => {
    await openLanding(page);
    const watch = await watchDocumentReloads(page);
    // Next が差し替える前の pushState (History.prototype の元の実装) で、state が null の #how の項目を積む。
    // hashchange は起きないので部品は印を付けず、Next の状態も / のまま (部品が印を付ける前に積まれた項目と同じ形)
    await page.evaluate((hash) => History.prototype.pushState.call(window.history, null, '', hash), REPORTED_HASH);
    await expect(page).toHaveURL(new RegExp(`/${REPORTED_HASH}$`));
    await goToSignupFromHeader(page);
    await waitForEffectsAfterPaint(page);

    await page.goBack();

    // state が null の項目なので Next は何もせず、画面 (/signup) と URL (/#how のルートの /) がずれる。部品が今の URL で 1 回だけ読み込み直す
    await expect(page).toHaveURL(new RegExp(`/${REPORTED_HASH}$`));
    await expect(page.locator(REPORTED_HASH)).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: SIGNUP_HEADING })).toHaveCount(0);
    expect(watch.loadCount()).toBe(1);
    expect(await watch.markerSurvives()).toBe(false);
  });
});
