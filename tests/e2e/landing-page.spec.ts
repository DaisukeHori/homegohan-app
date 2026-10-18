/**
 * #1867 紹介ページ (/) の e2e (docs/design/marketing/01-landing-site.md v2.0 §16.3 の E-1〜E-31)。未ログインで本番ビルド (CSP は nonce 方式) を開く。
 *
 * 確かめるのは、構造 (18 の区切り・見出し・ランドマーク)・操作 (デモ・FAQ の details・キーボード・ページの中のリンクと戻る)・
 * スクロールで決まる状態 (物語の固定した端末・スコアの輪・流れの図の線・拡大の箱・読む位置の棒・ナビの強調)・横にスクロールする帯・
 * 動きを減らす設定と JS 無し・拡大と幅 (320〜1280 px)・速さの予算 (LCP / CLS / JS の転送量 / 外部の要求)・CSP 違反 0・axe (WCAG 2.2 AA) の違反 0。
 * 検査の手がかりは、部品の名前・LANDING_COPY の文言・区切りの id・役割とアクセシブルな名前と、設計書が名指しする属性
 * (手順の li の id `how-step-<n>`・固定した端末の画像の `data-active`・`data-js`・`data-in`・`data-zoom-lens`・`aria-hidden`・
 * SVG の `pathLength`・`stroke-dasharray`) だけにする (実装のクラス名を前提にしない。例外として、設計書が名指しする紹介ページの根 `.lp` を使う:
 * 動いている Animation を数える範囲と、時間のトークン `--lp-dur-draw` を読む場所)。
 * FAQ は details と summary (ボタンも aria-expanded も無い)。ハイドレーションを待つ手がかりはデモの写真のボタン (島) とナビのリンク (島) で、FAQ は使わない (島でない)。
 * 速さの予算の環境変数 (LANDING_LCP_BUDGET_MS・LANDING_CLS_BUDGET・LANDING_JS_BUDGET_BYTES) はテストの実行時だけ読む (計測機の性能差のため)。
 * dev サーバでは LCP が本番より遅いので、local-ci.sh の e2e 段 (本番ビルド) で測る。
 * /signup などを経る戻る・進むは門の tests/e2e/back-navigation.spec.ts (#1893) が確かめるので、ここ (E-23) は紹介ページの中の戻るだけを見る。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  COUNT_UP_MS,
  DEMO_ANALYZING_MS,
  DEMO_NUTRITION_KEYS,
  LANDING_COPY,
  RING_DRAW_MS,
  RING_MAX,
  SCENES_STRIP_LABEL,
  SECTION_IDS,
  ZOOM_DRAW_MS,
  ZOOM_FROM_SCALE,
  demoPraiseComment,
  demoScore,
  screenStripLabel,
  type ChapterZoom,
  type NavKey,
} from '../../src/components/marketing/landing-copy';
import { landingZoomBySrc } from '../../src/components/marketing/landing-screens';

// playwright.config.ts の共有ログイン状態 (storageState) を引き継がず、未ログインで確かめる
test.use({ storageState: { cookies: [], origins: [] } });

// ─── 定数 ───

/** dev サーバの初回コンパイルや遅い機械を待てるよう、画面遷移直後の可視性アサーションだけ長めにする */
const NAVIGATION_TIMEOUT = 30_000;
/** 現れ方 (Reveal) の確認を行う画面の大きさ。1280×720 / スマートフォン / 1280×720 を 200 % に拡大したもの (CSS の 640×360) */
const REVEAL_CHECK_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
  { width: 640, height: 360 },
] as const;
const DESKTOP = { width: 1280, height: 720 } as const;
const PHONE = { width: 375, height: 667 } as const;
/** 短いラベルが折れないことを確かめる幅 (E-22) */
const LABEL_WIDTHS = [320, 375, 640, 768, 1024, 1280] as const;
const LABEL_HEIGHT = 800;
/**
 * E-22 のテスト 1 本の時間の上限 (ms)。LABEL_WIDTHS の 6 つの幅のそれぞれで、開く・ハイドレーションを待つ・デモの結果を出す・
 * 約 70 の短いラベルを測るので、既定 (playwright.config.ts の 60 s) より長くする
 */
const E22_TIMEOUT_MS = 180_000;
/** 横スクロールが無いことを確かめる幅 (E-6)。320 = WCAG 1.4.10 (リフロー) の幅、640 = 1280 px の画面を 200 % に拡大したときの CSS の幅 */
const REFLOW_CHECK_WIDTHS = [320, 640] as const;
/** E-6 の画面の高さ (px)。横スクロールの有無は高さに依らない (高さで変わるのは末尾までのスクロールの回数だけ) */
const REFLOW_CHECK_HEIGHT = 700;
/**
 * 動きを減らす設定で、写真を押してから結果が出るまでの上限 (ms。E-7)。設計書 §6.1 は待ち時間を 0 にする (DEMO_ANALYZING_MS_REDUCED)。
 * 通常の待ち (DEMO_ANALYZING_MS = 1,400 ms) の半分を上限にして、reduce でも通常の待ちをする実装を落とす (描画の時間の余裕は残す)
 */
const REDUCED_RESULT_MAX_MS = DEMO_ANALYZING_MS / 2;
/** 失敗の文に載せる、要素の文字の抜き出しの長さ (文字数。失敗の文を読める長さに保つためだけの値) */
const EXCERPT_CHARS = 20;
/** ヒーローの立ち上がりの最長 (620 ms) より十分長い待ち (ms)。読み込みからこの時間のあとに動いている Animation が無いことを確かめる */
const HERO_SETTLE_MS = 2_000;
/** スクロールを 1 回進めたあと、IntersectionObserver と描画が追いつくのを待つ時間 (ms) */
const SCROLL_STEP_WAIT_MS = 120;
/** スクロールの最大の回数 (ページの末尾に着かないままの無限ループを防ぐ) */
const SCROLL_MAX_STEPS = 400;
/** 予算 (環境変数で上書きできる。既定は設計書 §10.1) */
const DEFAULT_LCP_BUDGET_MS = 2_500;
const DEFAULT_CLS_BUDGET = 0.1;
/**
 * JS の転送量 (gzip) の既定の予算 (設計書 §10.1・§16.3 の E-11: 256 KB = 262144)。v1.7 の実測 227 KB (本番ビルド・Next 16.4.1。
 * 島を 1 つも持たない /terms の時点で 179 KB) に、v2.0 で足す島 (StoryScroller・ScoreRing・ReadingProgress・useInViewIds ほか) と
 * アイコンの見積もりと余裕を足した値。計測機・版で変わるので、環境変数 LANDING_JS_BUDGET_BYTES で上書きできる
 */
const DEFAULT_JS_BUDGET_BYTES = 256 * 1024;
const LCP_BUDGET_MS = Number(process.env.LANDING_LCP_BUDGET_MS ?? DEFAULT_LCP_BUDGET_MS);
const CLS_BUDGET = Number(process.env.LANDING_CLS_BUDGET ?? DEFAULT_CLS_BUDGET);
const JS_BUDGET_BYTES = Number(process.env.LANDING_JS_BUDGET_BYTES ?? DEFAULT_JS_BUDGET_BYTES);
/** E-11 で記録する HTML の大きさの目安 (設計書 §10.1: gzip 前で 120 KB 以下。判定はしない。記録の文に添えるだけ) */
const HTML_SIZE_NOTE_BYTES = 120 * 1024;
/** 文字の大きさの下限 (px。globals.css の --a11y-min-font-size)・本文の下限・lead の下限 */
const MIN_FONT_PX = 14;
const BODY_FONT_PX = 16;
const LEAD_FONT_PX = 17;
/** ターゲットの大きさ (px。WCAG 2.5.8 の 24・ヘッダーのトークンの 44・CTA の min-height: 3rem の 48。設計書 §5.3) */
const MIN_TARGET_PX = 24;
const HEADER_TARGET_PX = 44;
const CTA_TARGET_PX = 48;
/** 見た目の記録の置き場 (比較はしない。整合ゲートで目視) */
const EVIDENCE_DIR = path.join('tests', 'e2e', '.evidence', 'landing');
/** ピンチの拡大の上限として求める maximum-scale の下限 (Lighthouse の meta-viewport の監査は 5 未満を不合格にする) */
const MIN_ALLOWED_MAXIMUM_SCALE = 5;
/** axe のタグ (docs/design/cross/05-i18n-a11y.md §5.2 の 4 つに wcag22aa を足した 5 つ) */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SIGNUP_HREF = '/signup';
const PICKER_NAME = LANDING_COPY.demo.pickerTitle;
const FAQ_FIRST_ANSWER_LIMIT_SENTENCE = '1 日にご利用いただける回数';
/** ヘッダーのナビの名前 (SiteHeader の nav の aria-label) */
const NAV_NAME = 'サイトの案内';
/** ヘッダーのナビの 5 つの先 (設計書 §16.3 の E-15。Tab の順) */
const NAV_HREFS = ['#how', '#features', '#family', '#pricing', '#faq'] as const;
/** 375 px でヒーローに見える画面の数 (§5.4: 640 px 未満は遠くの 2 枚が display: none) */
const HERO_PHONE_VISIBLE_SCREENS = 3;
/** デモの 1 つ目の写真 (サラダ) のスコア (E-3 のテスト名の 87。見本の推定の値から demoScore が出す値と同じであることも確かめる) */
const FIRST_SAMPLE_SCORE = 87;
/** スコアの輪の値 (撮影の見本と同じ) と、最後の形の stroke-dashoffset (RING_MAX − 値) */
const RING_VALUE = LANDING_COPY.chapters.nutrition.ring.value;
const RING_FINAL_OFFSET = RING_MAX - RING_VALUE;
/** スコアの輪の、画面に入る前 (armed) の見える数字 (§13.3: 動きを減らす設定でなければ 0) */
const RING_ARMED_SHOWN = '0';
/** スコアの輪の値の circle (stroke-dasharray を持つのは値の circle だけ。下地の circle は持たない) */
const RING_VALUE_CIRCLE = '#nutrition circle[stroke-dasharray]';
/** stroke-dashoffset の比べの許し (輪は ± 0.5 (§16.3 の E-7・E-25)、流れの図の線 (長さ 1) は ± 0.01) */
const RING_OFFSET_TOLERANCE = 0.5;
const FLOW_OFFSET_TOLERANCE = 0.01;
/** 流れの図の線の長さ (path の pathLength="1")。画面に入る前の stroke-dashoffset (隠している形) と同じ */
const FLOW_PATH_LENGTH = 1;
/** 流れの図の線 (仕組みの区切りの中の、pathLength="1" の path。§5.7) */
const FLOW_PATH = '#how path[pathLength="1"]';
/** 描き終わりを待つときに足す余裕 (ms。§16.3 の「COUNT_UP_MS + 100 ms」「+ 200 ms」) */
const COUNT_UP_SLACK_MS = 100;
const DRAW_SLACK_MS = 200;
/** 拡大の箱の検査の許し: 倍率と縦横比は ± 0.01、画像と箱の位置と大きさの差は 2 px (縁 1 px を含む) */
const ZOOM_RATIO_TOLERANCE = 0.01;
const ZOOM_FIT_TOLERANCE_PX = 2;
/** 帯を 1 枚ぶん送ったときの止まる位置の許し (px) */
const SNAP_TOLERANCE_PX = 2;
/** スクロールが止まったとみなす確かめの間隔 (ms。この間を空けて 2 回読み、同じ位置なら止まった) */
const SCROLL_SETTLE_INTERVAL_MS = 150;
/** 位置の差の許し (px。sticky の上端) */
const POSITION_TOLERANCE_PX = 1;
/** E-21: sticky を確かめるために足すスクロールは、画面の高さのこの分の 1 (§16.3 の「画面の高さの 1/4」) */
const STICKY_CHECK_SCROLL_DIVISOR = 4;
/** 読む位置の棒: 開いた直後の上限・末尾の下限 (§16.3 の E-24) */
const PROGRESS_START_MAX = 0.05;
const PROGRESS_END_MIN = 0.95;
/** 読む位置の棒を途中で測る位置 (スクロールできる量の割合。§16.3 の E-24 の「途中 3 点」) */
const PROGRESS_MID_POINTS = [0.25, 0.5, 0.75] as const;
/** E-29: ナビの「料金」まで Tab で進む回数の上限 (スキップリンク・マーク・ナビ 4 つの 6 回で着く) */
const TAB_SEARCH_MAX = 20;
/** 物語の手順の li の id (§8.3 の StorySection: how-step-1〜4) と、3 番目の手順の添字 (0 から) */
const storyStepSelector = (stepNumber: number): string => `#how-step-${stepNumber}`;
const STORY_STEP_3 = 3;
const STORY_STEP_2 = 2;
const STORY_STEP_1 = 1;
/** 横にスクロールする帯の箱の名前 (§5.4 の表の 6 つ) */
const STRIP_LABELS = [
  SCENES_STRIP_LABEL,
  screenStripLabel(LANDING_COPY.chapters.photo.eyebrow),
  screenStripLabel(LANDING_COPY.chapters.menu.eyebrow),
  screenStripLabel(LANDING_COPY.chapters.nutrition.eyebrow),
  screenStripLabel(LANDING_COPY.chapters.badges.eyebrow),
  screenStripLabel(LANDING_COPY.guide.eyebrow),
] as const;
/** E-9 で大きさとフォーカスのリングを見るリンクの範囲 (§16.3 の E-9: v1.7 のヒーロー・最終 CTA・フッター・安心に、機能のカード・章・家族・料金・組織・ガイドを足す) */
const TARGET_SCOPES = ['#hero', '#features', '#photo', '#menu', '#nutrition', '#health', '#badges', '#chat', '#family', '#org', '#trust', '#pricing', '#guide', '#cta', 'footer'] as const;
/** CTA (CtaLink。min-height: 3rem) の文 (E-9 で 48 px 以上を求める。ヘッダーの小さい CTA は別に 44 px で見る) */
const CTA_LABELS: ReadonlySet<string> = new Set([
  LANDING_COPY.hero.primaryCta.label,
  LANDING_COPY.hero.secondaryCta.label,
  LANDING_COPY.org.cta.label,
  LANDING_COPY.guide.cta.label,
  LANDING_COPY.finalCta.cta.label,
]);

declare global {
  interface Window {
    __landingVitals?: { lcp: { startTime: number; inHero: boolean; element: string }[]; layoutShift: number };
    __landingCspViolations?: string[];
    __landingDemoTiming?: { pressedAt: number | null; resultAt: number | null; shownAtResult: string | null };
    __landingRingArmed?: { shown: string | null; dashoffset: string } | null;
    __landingStoryOpacity?: string | null;
  }
}

// ─── 共通の道具 ───

/** 画面の大きさを変えて開く (読み込みの完了まで) */
async function open(page: Page, viewport: { width: number; height: number } = DESKTOP): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await page.waitForLoadState('load');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
}

/** 島 (client の部品) がハイドレーションされるのを待つ: React がハイドレーションした要素には内部の props の鍵が付く */
async function waitForHydration(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps$'))), { timeout: NAVIGATION_TIMEOUT })
    .toBe(true);
}

/** 時間で進む Animation (document.timeline のもので、繰り返しが無限でないもの) がすべて終わるのを待つ。取り消された Animation の finished の拒否は、待ち終わりとして扱う */
async function waitForTimeAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getComputedTiming().iterations;
      return animation.timeline === document.timeline && iterations !== Infinity;
    });
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** 描画のフレームを 2 つ待つ (スクロールのあとの scroll の処理・rAF・IntersectionObserver の通知が 1 巡するまで) */
async function waitForFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** ページの末尾まで、画面の高さの半分ずつ mouse.wheel でスクロールし、そのたびに指定の確認を行う */
async function scrollThroughPage(page: Page, onStep?: () => Promise<void>): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport が無い');
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let step = 0; step < SCROLL_MAX_STEPS; step += 1) {
    const atEnd = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1);
    if (onStep) await onStep();
    if (atEnd) return;
    await page.mouse.wheel(0, viewport.height / 2);
    await page.waitForTimeout(SCROLL_STEP_WAIT_MS);
  }
  throw new Error('ページの末尾に着かない');
}

/** 末尾までスクロールして現れ方をすべて現し、時間で進む Animation が終わるのを待つ */
async function revealEverything(page: Page): Promise<void> {
  await scrollThroughPage(page);
  await waitForTimeAnimations(page);
}

/** 要素の中心を画面の中央へ (スクロールの位置を直に決める。scroll-behavior を書いていないので一瞬で移る) */
async function scrollCenterTo(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    window.scrollTo(0, rect.top + window.scrollY + rect.height / 2 - window.innerHeight / 2);
  });
}

/** main の見える要素 (空白だけでない文字のテキストノードを子に持つ要素と img。aria-hidden の中を除く) のうち、自分から main までの先祖の opacity が 1 でないもの */
async function hiddenByOpacity(page: Page): Promise<string[]> {
  return page.evaluate((excerptChars) => {
    const main = document.querySelector('main');
    if (!main) return ['main が無い'];
    const hidden: string[] = [];
    const candidates = [main, ...Array.from(main.querySelectorAll('*'))].filter((element) => {
      if (element.closest('[aria-hidden="true"]')) return false;
      if (element.tagName === 'IMG') return true;
      return Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
    });
    for (const element of candidates) {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (getComputedStyle(node).opacity !== '1') {
          hidden.push(`${element.tagName.toLowerCase()}「${(element.textContent ?? '').trim().slice(0, excerptChars)}」(opacity ${getComputedStyle(node).opacity})`);
          break;
        }
        if (node === main) break;
      }
    }
    return hidden;
  }, EXCERPT_CHARS);
}

/** 横スクロールが無い (scrollWidth <= clientWidth) */
async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `${label}: 横スクロールが出ている`).toBeLessThanOrEqual(overflow.clientWidth);
}

/** document.activeElement の outline-style (none でなければ、見えるフォーカスのリングが出ている) */
async function activeOutlineStyle(page: Page): Promise<string> {
  return page.evaluate(() => (document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : 'none'));
}

/** main の直下の section の id の並び */
async function sectionIdsOf(page: Page): Promise<string[]> {
  return page.locator('main > section').evaluateAll((sections) => sections.map((section) => section.id));
}

/** computed の transform (none / matrix(a, b, c, d, e, f) / matrix3d(…)) の横の倍率 a。none は 1 */
function scaleXOf(transform: string): number {
  if (transform === 'none') return 1;
  const values = /matrix(?:3d)?\(([^)]+)\)/.exec(transform)?.[1].split(',').map((value) => Number(value.trim()));
  if (!values || values.some((value) => Number.isNaN(value))) throw new Error(`transform を読めない: ${transform}`);
  return values[0];
}

/** computed の transform が何も動かさない形 (none か単位行列) */
function isIdentityTransform(transform: string): boolean {
  if (transform === 'none') return true;
  const values = /matrix\(([^)]+)\)/.exec(transform)?.[1].split(',').map((value) => Number(value.trim()));
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const EPSILON = 1e-6;
  return values !== undefined && values.length === IDENTITY.length && values.every((value, index) => Math.abs(value - IDENTITY[index]) < EPSILON);
}

/** 紹介ページの根 (.lp) の時間のトークン (例 --lp-dur-draw) を ms で読む */
async function lpDurationMs(page: Page, token: string): Promise<number> {
  const raw = await page.locator('.lp').evaluate((root, name) => getComputedStyle(root).getPropertyValue(name).trim(), token);
  const MS_PER_SECOND = 1000;
  const match = /^([0-9.]+)(ms|s)$/.exec(raw);
  if (!match) throw new Error(`${token} を時間として読めない: 「${raw}」`);
  return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * MS_PER_SECOND;
}

/** デモの結果の箱 (role=status) */
const demoStatus = (page: Page): Locator => page.locator('#demo').getByRole('status');
const pickerButtons = (page: Page): Locator => page.getByRole('group', { name: PICKER_NAME }).getByRole('button');

/** 写真のボタンにキーボードで触る: focus してから Enter。ハイドレーションの前に押して空振りしないよう、先に待つ */
async function pressPhoto(page: Page, index: number): Promise<void> {
  const button = pickerButtons(page).nth(index);
  await waitForHydration(button);
  await button.focus();
  await page.keyboard.press('Enter');
}

/** ハイドレーションを待たずに、いまのフォーカスの移動と Enter だけを行う (分析中の再選択のように、時間の余裕が小さい操作用) */
async function pressPhotoNow(page: Page, index: number): Promise<void> {
  await pickerButtons(page).nth(index).focus();
  await page.keyboard.press('Enter');
}

/** 根の中の数字の 2 つの文: 見える数字 (aria-hidden の中の数字。増えている間の値) と、最後の値の要素 (aria-hidden の外の span。読み上げる方) */
async function numberTexts(root: Locator): Promise<{ shown: string | null; final: string | null }> {
  return root.evaluate((element) => {
    const isNumber = (text: string) => /^\d+$/.test(text);
    const textOf = (node: Element) => (node.textContent ?? '').trim();
    const shown = Array.from(element.querySelectorAll('[aria-hidden="true"]')).map(textOf).find(isNumber) ?? null;
    const final =
      Array.from(element.querySelectorAll('span'))
        .filter((span) => !span.closest('[aria-hidden="true"]'))
        .map(textOf)
        .find(isNumber) ?? null;
    return { shown, final };
  });
}

/** ヘッダー (banner)・ヘッダーのナビ・読む位置の棒 (ヘッダーの直下の aria-hidden の要素) */
const banner = (page: Page): Locator => page.getByRole('banner');
const siteNav = (page: Page): Locator => page.getByRole('navigation', { name: NAV_NAME });
const readingBar = (page: Page): Locator => banner(page).locator(':scope > [aria-hidden="true"]');

/** ナビの項目の文 (LANDING_COPY.header.nav の鍵で引く) */
function navLabel(key: NavKey): string {
  const item = LANDING_COPY.header.nav.find((navItem) => navItem.key === key);
  if (!item) throw new Error(`ナビに ${key} が無い`);
  return item.label;
}

/** 機能のカードの見出し (LANDING_COPY.features.cards の id で引く) */
function featureCardTitle(id: string): string {
  const card = LANDING_COPY.features.cards.find((featureCard) => featureCard.id === id);
  if (!card) throw new Error(`機能のカードに ${id} が無い`);
  return card.title;
}

/** 章の拡大 (章 photo・menu だけが持つ。null なら設計と違うので止める) */
function chapterZoom(zoom: ChapterZoom | null, chapter: string): ChapterZoom {
  if (!zoom) throw new Error(`章 ${chapter} に拡大が無い`);
  return zoom;
}

/** FAQ の details と summary */
const faqDetails = (page: Page): Locator => page.locator('#faq details');
const faqSummaries = (page: Page): Locator => page.locator('#faq summary');

/** 物語の固定した端末の 4 枚 (data-active を持つ img) */
const storyStageImages = (page: Page): Locator => page.locator('#how img[data-active]');

/** 固定した端末に JS が動いた印 (data-js の根) が付くのを待つ */
async function waitForStoryStage(page: Page): Promise<void> {
  await expect.poll(() => storyStageImages(page).first().evaluate((image) => image.closest('[data-js]') !== null), { timeout: NAVIGATION_TIMEOUT }).toBe(true);
}

/** 固定した端末で index 番目 (0 から) の画面だけが見えている (opacity 1・aria-hidden="false"。ほかは opacity 0・aria-hidden="true") のを待つ */
async function expectStoryActive(page: Page, index: number): Promise<void> {
  const count = await storyStageImages(page).count();
  const expected = Array.from({ length: count }, (_, position) => (position === index ? '1 false' : '0 true'));
  await expect
    .poll(() => storyStageImages(page).evaluateAll((images) => images.map((image) => `${getComputedStyle(image).opacity} ${image.getAttribute('aria-hidden')}`)), {
      timeout: NAVIGATION_TIMEOUT,
    })
    .toEqual(expected);
}

/** 横にスクロールする帯の箱 (role="region"・§5.4 の aria-label) */
const stripRegion = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

/** 帯の箱の横のスクロールが止まるのを待つ (間を空けて 2 回読み、同じ位置になるまで) */
async function waitForStripSettled(box: Locator): Promise<void> {
  const page = box.page();
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(SCROLL_SETTLE_INTERVAL_MS);
        const current = await box.evaluate((element) => element.scrollLeft);
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: NAVIGATION_TIMEOUT },
    )
    .toBe(true);
}

/** 帯の箱を 1 枚ぶん (1 枚目の li の幅 + 列の間) 送る */
async function advanceStripByOneItem(box: Locator): Promise<void> {
  await box.evaluate((element) => {
    const list = element.querySelector('ul');
    const first = list?.querySelector('li');
    if (!list || !first) throw new Error('帯の中に ul と li が無い');
    const columnGap = parseFloat(getComputedStyle(list).columnGap) || 0;
    element.scrollBy({ left: first.getBoundingClientRect().width + columnGap });
  });
}

/** スコアの輪の根 (値の circle に最も近い data-js の先祖) の状態。根に data-js が付く前は armed が false */
async function ringSnapshot(page: Page): Promise<{ armed: boolean; inView: boolean; shown: string | null; final: string | null; dashoffset: number }> {
  return page.locator(RING_VALUE_CIRCLE).evaluate((circle) => {
    const root = circle.closest('[data-js]');
    const isNumber = (text: string) => /^\d+$/.test(text);
    const textOf = (node: Element) => (node.textContent ?? '').trim();
    const scope = root ?? circle.parentElement?.parentElement ?? circle;
    return {
      armed: root !== null,
      inView: root?.hasAttribute('data-in') ?? false,
      shown: Array.from(scope.querySelectorAll('[aria-hidden="true"]')).map(textOf).find(isNumber) ?? null,
      final:
        Array.from(scope.querySelectorAll('span'))
          .filter((span) => !span.closest('[aria-hidden="true"]'))
          .map(textOf)
          .find(isNumber) ?? null,
      dashoffset: parseFloat(getComputedStyle(circle).strokeDashoffset),
    };
  });
}

/** 要素の computed の stroke-dashoffset (px の数) */
async function dashoffsetOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => parseFloat(getComputedStyle(element).strokeDashoffset));
}

/** 章の拡大の箱 (data-zoom-lens) */
const zoomLens = (page: Page, sectionSelector: string): Locator => page.locator(`${sectionSelector} [data-zoom-lens]`);

/** 拡大の箱の computed の opacity と transform */
async function lensStyle(lens: Locator): Promise<{ opacity: string; transform: string }> {
  return lens.evaluate((element) => ({ opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform }));
}

/** 拡大の箱を画面の中央へ移し、立ち上がり (M-17) が始まってから ZOOM_DRAW_MS + 200 ms 待つと、不透明で元の大きさ */
async function expectLensDrawnAfterScroll(page: Page, lens: Locator, label: string): Promise<void> {
  await scrollCenterTo(lens);
  await expect.poll(async () => Number((await lensStyle(lens)).opacity), { timeout: NAVIGATION_TIMEOUT }).toBeGreaterThan(0);
  await page.waitForTimeout(ZOOM_DRAW_MS + DRAW_SLACK_MS);
  const after = await lensStyle(lens);
  expect(after.opacity, `${label}: 入った後の opacity`).toBe('1');
  expect(isIdentityTransform(after.transform), `${label}: 入った後の transform (${after.transform})`).toBe(true);
}

/** タグ付きの axe (違反の規則の id と対象の要素を、失敗のときに出す) */
async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
  expect(summary, `${label}: axe の違反`).toEqual([]);
}

/**
 * E-7: スコアの輪の根に data-js が付いた通知の中で (同じタスクの中で)、見える数字と輪の値の circle の computed の stroke-dashoffset を記録する。
 * ページの読み込みの前に入れる (page.addInitScript。関数はそのまま文字にされて送られるので、外の変数を使わない)
 */
function recordRingArmed(): void {
  window.__landingRingArmed = null;
  new MutationObserver((records) => {
    if (window.__landingRingArmed) return;
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof Element) || !target.hasAttribute('data-js') || !target.closest('#nutrition')) continue;
      const circle = target.querySelector('circle[stroke-dasharray]');
      if (!circle) continue;
      const shown =
        Array.from(target.querySelectorAll('[aria-hidden="true"]'))
          .map((element) => (element.textContent ?? '').trim())
          .find((text) => /^\d+$/.test(text)) ?? null;
      window.__landingRingArmed = { shown, dashoffset: getComputedStyle(circle).strokeDashoffset };
      return;
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-js'] });
}

// ─── テスト ───

test.describe('#1867 紹介ページ (/)', () => {
  for (const viewport of REVEAL_CHECK_VIEWPORTS) {
    test(`E-1 ${viewport.width}×${viewport.height}: 18 の区切りが順にあり、末尾までスクロールすると隠れたままの要素が無い`, async ({ page }) => {
      await open(page, viewport);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(LANDING_COPY.hero.headlineLines.join(''));
      expect(await sectionIdsOf(page)).toEqual([...SECTION_IDS]);
      // ログインのフォームではない
      await expect(page.locator('#email')).toHaveCount(0);
      // 帯の中の要素も下の検査の対象: 場面の帯には 4 枚 (狭い幅では見える幅の外の 3・4 枚目を含む) のカードの見出しがある
      await expect(stripRegion(page, SCENES_STRIP_LABEL).getByRole('heading', { level: 3 })).toHaveCount(LANDING_COPY.scenes.items.length);
      await waitForHydration(pickerButtons(page).first());
      await revealEverything(page);
      expect(await hiddenByOpacity(page)).toEqual([]);
    });
  }

  test('E-2 ヘッダーとヒーローの「無料で始める」は /signup を指し、「デモを試す」は #demo へスクロールする', async ({ page }) => {
    await open(page);
    const headerCta = banner(page).getByRole('link', { name: LANDING_COPY.header.cta.label });
    const heroCta = page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.primaryCta.label });
    await expect(headerCta).toHaveAttribute('href', SIGNUP_HREF);
    await expect(heroCta).toHaveAttribute('href', SIGNUP_HREF);
    await page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.secondaryCta.label }).click();
    await expect
      .poll(async () => {
        const top = await page.locator('#demo').evaluate((element) => element.getBoundingClientRect().top);
        const height = await page.evaluate(() => window.innerHeight);
        return top >= 0 && top < height;
      })
      .toBe(true);
  });

  test('E-3 デモ: 写真を Enter で押すと分析中を経て結果が出て、スコアが 87 で止まり、フォーカスは押したボタンに残り、分析中の再選択は無視される', async ({ page }) => {
    await open(page);
    const demo = LANDING_COPY.demo;
    const status = demoStatus(page);
    const buttons = pickerButtons(page);
    await expect(buttons).toHaveCount(demo.samples.length);

    // (4) サンプルの注記は、写真を押す前から見えていて、結果の箱の外にある
    const notice = page.locator('#demo').getByText(demo.sampleNotice, { exact: true });
    await expect(notice).toBeVisible();
    await expect(status.getByText(demo.sampleNotice)).toHaveCount(0);

    // (1) 1 つ目 (サラダ) を Enter で押す
    await pressPhoto(page, 0);
    await expect(status).toContainText(demo.analyzingTitle);
    for (let index = 0; index < demo.samples.length; index += 1) {
      await expect(buttons.nth(index)).toHaveAttribute('aria-disabled', 'true');
      await expect(buttons.nth(index)).not.toHaveAttribute('disabled');
    }
    // フォーカスは押したボタンそのもの (文字の一致では、同じ名前を出す結果の箱や body でも通るので、要素の同一性で確かめる)
    expect(await buttons.nth(0).evaluate((element) => element === document.activeElement), '分析中のフォーカスが押したボタン').toBe(true);
    expect(await activeOutlineStyle(page)).not.toBe('none');
    await expect(notice).toBeVisible();

    // (2) 結果。スコアの最後の値の要素 (読み上げる方) は最初から最後の値で、見える数字は COUNT_UP_MS で増えて最後の値で止まる
    const first = demo.samples[0];
    const firstScore = demoScore(first.nutrition);
    expect(firstScore, 'テスト名の 87 は 1 つ目の見本のスコア').toBe(FIRST_SAMPLE_SCORE);
    await expect(status).toContainText(String(firstScore), { timeout: NAVIGATION_TIMEOUT });
    expect((await numberTexts(status)).final, '最後の値の要素').toBe(String(firstScore));
    await expect(status).toContainText(demo.scoreNote);
    await expect(status.getByRole('heading', { name: demo.resultTitle })).toBeVisible();
    await expect(status).toContainText(demoPraiseComment(first));
    await expect(status.getByRole('heading', { name: demo.nutritionTitle })).toBeVisible();
    for (const key of DEMO_NUTRITION_KEYS) {
      await expect(status).toContainText(demo.nutritionLabels[key]);
      await expect(status).toContainText(`${first.nutrition[key]}${demo.nutritionUnits[key]}`);
    }
    await expect(status.getByRole('link', { name: demo.cta.label })).toHaveAttribute('href', SIGNUP_HREF);
    for (let index = 0; index < demo.samples.length; index += 1) {
      await expect(buttons.nth(index)).toHaveAttribute('aria-disabled', 'false');
    }
    expect(await buttons.nth(0).evaluate((element) => element === document.activeElement), '結果が出た後のフォーカスが押したボタン').toBe(true);
    expect(await activeOutlineStyle(page)).not.toBe('none');
    await expect(notice).toBeVisible();
    await expect(status.getByText(demo.sampleNotice)).toHaveCount(0);
    await page.waitForTimeout(COUNT_UP_MS + COUNT_UP_SLACK_MS);
    expect(await numberTexts(status), '増え終わった後の見える数字と最後の値の要素').toEqual({ shown: String(firstScore), final: String(firstScore) });

    // (3) 2 つ目 (サーモン) を押すと、もう一度分析中を経て結果に替わる。分析中に 3 つ目を押しても変わらない
    const second = demo.samples[1];
    await pressPhoto(page, 1);
    await expect(status).toContainText(demo.analyzingTitle);
    await pressPhotoNow(page, 2);
    await expect(status).toContainText(demo.analyzingTitle);
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'false');
    await expect(status).toContainText(String(demoScore(second.nutrition)), { timeout: NAVIGATION_TIMEOUT });
    await expect(status).toContainText(demoPraiseComment(second));
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'false');
    await expect(notice).toBeVisible();
  });

  test('E-4 FAQ: 12 の details があり、summary を Enter で開閉でき、1 つ目の答えに 1 日の利用回数の上限の文があり、JS が無くても summary を押すと答えが見える', async ({ page }) => {
    await open(page);
    const details = faqDetails(page);
    const summaries = faqSummaries(page);
    await expect(details).toHaveCount(LANDING_COPY.faq.items.length);
    await expect(summaries).toHaveCount(LANDING_COPY.faq.items.length);
    for (let index = 0; index < LANDING_COPY.faq.items.length; index += 1) {
      await expect(details.nth(index)).not.toHaveAttribute('open');
    }
    // 1 つ目の summary を Enter で開き、もう一度 Enter で閉じる (開閉はブラウザの details。JS を待たない)
    await summaries.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect(details.nth(0)).toHaveAttribute('open');
    const firstAnswer = details.nth(0).getByText(FAQ_FIRST_ANSWER_LIMIT_SENTENCE);
    await expect(firstAnswer).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(details.nth(0)).not.toHaveAttribute('open');
    // 1 つ目を開いたまま 2 つ目を開くと、両方が開いている (name が無いので独立に開く)
    await summaries.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect(details.nth(0)).toHaveAttribute('open');
    await summaries.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(details.nth(1)).toHaveAttribute('open');
    await expect(details.nth(0)).toHaveAttribute('open');
    // JS 無しの開閉は下の describe (E-4 JS 無し) が確かめる
  });

  test('E-5 375 px: 横スクロールが無く、ヘッダーの「無料で始める」がどこまでスクロールしても画面の中に見える', async ({ page }) => {
    await open(page, PHONE);
    const cta = banner(page).getByRole('link', { name: LANDING_COPY.header.cta.label });
    const expectCtaInScreen = async (label: string) => {
      await expect(cta, label).toHaveAttribute('href', SIGNUP_HREF);
      const state = await cta.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, visibility: getComputedStyle(element).visibility, height: window.innerHeight };
      });
      expect(state.top, `${label}: 上端`).toBeGreaterThanOrEqual(0);
      expect(state.bottom, `${label}: 下端`).toBeLessThanOrEqual(state.height);
      expect(state.visibility, label).toBe('visible');
    };
    await expectNoHorizontalScroll(page, '開いた直後');
    await expectCtaInScreen('開いた直後');
    await page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.secondaryCta.label }).click();
    await expectCtaInScreen('デモを試すで #demo へ移った後');
    await scrollThroughPage(page, async () => {
      await expectCtaInScreen('スクロールの途中');
    });
    await expectNoHorizontalScroll(page, '末尾');
  });

  for (const width of REFLOW_CHECK_WIDTHS) {
    test(`E-6 ${width} px で横スクロールが無い (横にスクロールする帯はページの幅を増やさない)`, async ({ page }) => {
      await open(page, { width, height: REFLOW_CHECK_HEIGHT });
      await scrollThroughPage(page, async () => {
        await expectNoHorizontalScroll(page, `${width} px`);
      });
    });
  }

  test.describe('E-7 reduced-motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('E-7 動く Animation が無く、最初から見え、デモの結果は待ち無しで最後の見え方で出て、輪と線は最初から最後の形、数字は最初から最後の値、固定した端末は一瞬で替わる', async ({ page }) => {
      await page.addInitScript(recordRingArmed);
      await open(page);
      // 開いた直後 (スクロールの前)
      const running = await page.locator('.lp').evaluate((root) => root.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length);
      expect(running, '動いている Animation').toBe(0);
      expect(await hiddenByOpacity(page)).toEqual([]);
      const heroImages = page.locator('#hero img');
      await expect(heroImages).toHaveCount(LANDING_COPY.hero.screens.length);
      const heroOpacity = await heroImages.evaluateAll((images) =>
        images.map((image) => {
          const opacities: string[] = [];
          for (let node: Element | null = image; node; node = node.parentElement) opacities.push(getComputedStyle(node).opacity);
          return opacities;
        }),
      );
      for (const opacities of heroOpacity) expect(opacities.every((opacity) => opacity === '1')).toBe(true);

      // スコアの輪: マウントで根に data-js が付いた時点 (armed) で、見える数字は最後の値・輪は最後の形 (0 と全長を経ない)
      await expect.poll(() => page.evaluate(() => window.__landingRingArmed ?? null), { timeout: NAVIGATION_TIMEOUT }).not.toBeNull();
      const armed = await page.evaluate(() => window.__landingRingArmed ?? null);
      expect(armed?.shown, 'armed の時点の見える数字').toBe(String(RING_VALUE));
      expect(Math.abs(parseFloat(armed?.dashoffset ?? '') - RING_FINAL_OFFSET), `armed の時点の stroke-dashoffset (${armed?.dashoffset})`).toBeLessThanOrEqual(RING_OFFSET_TOLERANCE);

      // 流れの図の線: 最初から描かれている
      const flowPath = page.locator(FLOW_PATH);
      await expect(flowPath).toHaveCount(1);
      await expect.poll(() => flowPath.evaluate((element) => element.closest('[data-js]') !== null), { timeout: NAVIGATION_TIMEOUT }).toBe(true);
      expect(Math.abs(await dashoffsetOf(flowPath)), '線の stroke-dashoffset').toBeLessThanOrEqual(FLOW_OFFSET_TOLERANCE);

      // デモ: 待ち無しで結果が最後の見え方で出る。押した時刻 (Enter の keydown) と、結果の箱にスコアが出た時刻と、そのときの見える数字をページの中で測る
      // (Playwright の待ちの既定 10 s では、reduce でも通常の待ち (DEMO_ANALYZING_MS) をする実装が通ってしまうため)
      const demo = LANDING_COPY.demo;
      const first = demo.samples[0];
      const score = String(demoScore(first.nutrition));
      const status = demoStatus(page);
      await waitForHydration(pickerButtons(page).first());
      await expect(status).not.toContainText(score);
      await status.evaluate((box, expectedScore) => {
        const timing = { pressedAt: null as number | null, resultAt: null as number | null, shownAtResult: null as string | null };
        window.__landingDemoTiming = timing;
        document.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Enter' && timing.pressedAt === null) timing.pressedAt = performance.now();
          },
          { capture: true },
        );
        new MutationObserver(() => {
          if (timing.resultAt !== null || !(box.textContent ?? '').includes(expectedScore)) return;
          timing.resultAt = performance.now();
          timing.shownAtResult =
            Array.from(box.querySelectorAll('[aria-hidden="true"]'))
              .map((element) => (element.textContent ?? '').trim())
              .find((text) => /^\d+$/.test(text)) ?? null;
        }).observe(box, { subtree: true, childList: true, characterData: true });
      }, score);
      await pressPhoto(page, 0);
      await expect(status).toContainText(score);
      const timing = await page.evaluate(() => window.__landingDemoTiming ?? { pressedAt: null, resultAt: null, shownAtResult: null });
      expect(timing.pressedAt, '押した時刻が取れない').not.toBeNull();
      expect(timing.resultAt, '結果が出た時刻が取れない').not.toBeNull();
      expect((timing.resultAt ?? 0) - (timing.pressedAt ?? 0), '押してから結果が出るまで (ms)').toBeLessThanOrEqual(REDUCED_RESULT_MAX_MS);
      expect(timing.shownAtResult, '結果が出た時点の見える数字 (増えずに最初から最後の値)').toBe(score);
      const state = await page.evaluate(
        () =>
          new Promise<{ notFinal: string[]; running: number }>((resolve) => {
            requestAnimationFrame(() => {
              const box = document.querySelector('#demo [role="status"]');
              const notFinal: string[] = [];
              if (box) {
                for (const element of [box, ...Array.from(box.querySelectorAll('*'))]) {
                  const style = getComputedStyle(element);
                  if (style.opacity !== '1' || style.transform !== 'none') notFinal.push(`${element.tagName.toLowerCase()} opacity=${style.opacity} transform=${style.transform}`);
                }
              }
              const running = box ? box.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length : -1;
              resolve({ notFinal, running });
            });
          }),
      );
      expect(state.notFinal).toEqual([]);
      expect(state.running).toBe(0);

      // 固定した端末の入れ替えは一瞬: 3 枚目に data-active="true" が付いた通知の中 (同じタスク) で opacity を記録すると、もう 1
      // (rAF の時点では測らない: IntersectionObserver の通知と React の描き直しは rAF の後なので、scrollTo の直後の rAF ではまだ前の手順)
      await waitForStoryStage(page);
      await storyStageImages(page)
        .nth(STORY_STEP_3 - 1)
        .evaluate((image) => {
          window.__landingStoryOpacity = null;
          new MutationObserver(() => {
            if (window.__landingStoryOpacity === null && image.getAttribute('data-active') === 'true') window.__landingStoryOpacity = getComputedStyle(image).opacity;
          }).observe(image, { attributes: true, attributeFilter: ['data-active'] });
        });
      await scrollCenterTo(page.locator(storyStepSelector(STORY_STEP_3)));
      await expect.poll(() => page.evaluate(() => window.__landingStoryOpacity ?? null), { timeout: NAVIGATION_TIMEOUT }).toBe('1');
    });
  });

  test('E-8 img はすべて alt 属性を持ち、button はすべて見える名前を持ち、見出しは h1 → h2 → h3 の順を飛ばさない', async ({ page }) => {
    await open(page);
    const problems = await page.evaluate(() => {
      const found: string[] = [];
      for (const image of Array.from(document.querySelectorAll('.lp img'))) {
        if (!image.hasAttribute('alt')) found.push(`img に alt が無い: ${image.getAttribute('src')}`);
      }
      for (const button of Array.from(document.querySelectorAll('.lp button'))) {
        const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
        if (!name) found.push('名前の無い button');
      }
      const levels = Array.from(document.querySelectorAll('.lp h1, .lp h2, .lp h3')).map((heading) => Number(heading.tagName.slice(1)));
      if (levels[0] !== 1) found.push(`最初の見出しが h1 でない: h${levels[0]}`);
      levels.forEach((level, index) => {
        if (index > 0 && level > levels[index - 1] + 1) found.push(`見出しの飛び: h${levels[index - 1]} の次が h${level}`);
      });
      return found;
    });
    expect(problems).toEqual([]);
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`E-9 ${viewport.width} px: ターゲットの大きさ・フォーカスの見え方・固定ヘッダーがフォーカスを隠さないこと`, async ({ page }) => {
      await open(page, viewport);
      // ハイドレーションはデモの写真のボタン (島) で待つ (FAQ は島でない)
      await waitForHydration(pickerButtons(page).first());

      // ヘッダーの見えているリンクは高さ 44 px 以上
      const headerLinks = banner(page).getByRole('link').filter({ visible: true });
      const headerCount = await headerLinks.count();
      expect(headerCount).toBeGreaterThan(0);
      for (let index = 0; index < headerCount; index += 1) {
        const box = await headerLinks.nth(index).boundingBox();
        expect(box?.height ?? 0, `ヘッダーのリンク ${index}`).toBeGreaterThanOrEqual(HEADER_TARGET_PX);
      }
      // 区切りとフッターの見えているリンクは 24×24 px 以上 (CTA は高さ 48 px 以上) で、focus すると outline が出る
      for (const scope of TARGET_SCOPES) {
        const links = page.locator(scope).getByRole('link').filter({ visible: true });
        const count = await links.count();
        expect(count, `${scope} のリンク`).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
          const link = links.nth(index);
          const box = await link.boundingBox();
          const text = ((await link.textContent()) ?? '').trim();
          expect(box?.width ?? 0, `${scope} のリンク ${index}「${text}」の幅`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
          expect(box?.height ?? 0, `${scope} のリンク ${index}「${text}」の高さ`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
          if (CTA_LABELS.has(text)) expect(box?.height ?? 0, `${scope} の CTA「${text}」の高さ`).toBeGreaterThanOrEqual(CTA_TARGET_PX);
          await link.focus();
          expect(await activeOutlineStyle(page), `${scope} のリンク ${index}「${text}」の outline`).not.toBe('none');
        }
      }
      const summaries = faqSummaries(page);
      for (const target of [pickerButtons(page).first(), summaries.first()]) {
        await target.focus();
        expect(await activeOutlineStyle(page)).not.toBe('none');
      }

      // 固定ヘッダーがフォーカスを隠さない: 1 つ目の summary の下端が画面の上端より上になる位置へ移り、2 つ目の summary から Shift+Tab で戻る
      const firstBottom = await summaries.nth(0).evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
      await page.evaluate((y) => window.scrollTo(0, y + 1), firstBottom);
      await summaries.nth(1).focus();
      await page.keyboard.press('Shift+Tab');
      const covered = await page.evaluate(() => {
        const header = document.querySelector('.lp header');
        const target = document.activeElement;
        if (!header || !target) return { ok: false, detail: 'header か activeElement が無い' };
        const headerBottom = header.getBoundingClientRect().bottom;
        const targetTop = target.getBoundingClientRect().top;
        return { ok: targetTop >= headerBottom, detail: `target.top=${targetTop} header.bottom=${headerBottom}` };
      });
      expect(covered.ok, covered.detail).toBe(true);
      await expect(summaries.nth(0)).toBeFocused();
    });
  }

  test('E-10 LCP が予算以内で、LCP の要素が #hero の中にあり、CLS が予算以内', async ({ page }) => {
    await page.addInitScript((excerptChars) => {
      window.__landingVitals = { lcp: [], layoutShift: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const lcp = entry as PerformanceEntry & { element?: Element | null };
          window.__landingVitals?.lcp.push({
            startTime: lcp.startTime,
            inHero: Boolean(lcp.element?.closest('#hero')),
            element: lcp.element ? `${lcp.element.tagName.toLowerCase()}「${(lcp.element.textContent ?? '').trim().slice(0, excerptChars)}」${lcp.element.getAttribute('src') ?? ''}` : '(要素なし)',
          });
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput && window.__landingVitals) window.__landingVitals.layoutShift += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }, EXCERPT_CHARS);
    await open(page);
    await page.waitForTimeout(HERO_SETTLE_MS);
    const lcpEntries = await page.evaluate(() => window.__landingVitals?.lcp ?? []);
    expect(lcpEntries.length, 'LCP の候補が取れない').toBeGreaterThan(0);
    const lcp = lcpEntries[lcpEntries.length - 1];
    expect(lcp.startTime, 'LCP (ms)').toBeLessThanOrEqual(LCP_BUDGET_MS);
    // Chromium は、不透明度 0 で最初に描いた要素を LCP の候補に数えず、後で見えるようになっても描き直されるまで数えない (Chrome 86 からの規則)。
    // だからヒーローの画面の塊 (M-3) は不透明度を動かさずに立ち上がり、前の 1 枚 (preload) が最初の描画から LCP の候補になる。
    // e2e のビルドは Google Fonts のモック (フォントの差し替えによる描き直しが無い) なので、M-3 が不透明度 0 から始まると、ここでヘッダーの文字が LCP になって落ちる
    expect(lcp.inHero, `LCP の要素が #hero の中 (実際: ${lcp.element}。候補の履歴 ${JSON.stringify(lcpEntries)})`).toBe(true);
    // 遅れて読む画像・輪と数字・拡大の箱で枠が動かないことも見るため、末尾までスクロールしてから CLS を読む
    await revealEverything(page);
    const cls = await page.evaluate(() => window.__landingVitals?.layoutShift ?? 0);
    expect(cls, 'CLS').toBeLessThanOrEqual(CLS_BUDGET);
  });

  test('E-11 / で読む同じオリジンの script を gzip した大きさの合計が予算 (LANDING_JS_BUDGET_BYTES、既定 256 KB) 以内で、外部のオリジンへの要求が無く、HTML の大きさを記録する', async ({ page, baseURL }, testInfo) => {
    const scriptBodies: Buffer[] = [];
    const bodyReads: Promise<void>[] = [];
    const externalRequests: string[] = [];
    let htmlBytes: number | null = null;
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.origin !== origin && !url.pathname.startsWith('/_vercel/')) externalRequests.push(request.url());
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin) return;
      const type = response.request().resourceType();
      if (type === 'script') {
        bodyReads.push(response.body().then((body) => void scriptBodies.push(body)).catch(() => undefined));
      } else if (type === 'document' && url.pathname === '/') {
        bodyReads.push(
          response
            .body()
            .then((body) => {
              htmlBytes = body.length;
            })
            .catch(() => undefined),
        );
      }
    });
    await open(page);
    await waitForHydration(pickerButtons(page).first());
    await page.waitForTimeout(HERO_SETTLE_MS);
    await Promise.all(bodyReads);
    // 応答の content-length は使わない (next start は gzip して Content-Length を付けず、response.body() は展開した後のバイトを返す)。それぞれを gzip した長さの合計
    const sizes = scriptBodies.map((body) => zlib.gzipSync(body).length);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const BREAKDOWN_COUNT = 5;
    const largest = [...sizes].sort((a, b) => b - a).slice(0, BREAKDOWN_COUNT).join(', ');
    // HTML の大きさ (本文の長さ。gzip 前) は記録だけ (判定はしない: §10.1 の参考値)
    const htmlNote = `紹介ページの HTML: ${htmlBytes ?? '取れない'} バイト (gzip 前。§10.1 の目安 ${HTML_SIZE_NOTE_BYTES} バイト以下)・script の gzip の合計 ${total} バイト (${scriptBodies.length} 本)`;
    testInfo.annotations.push({ type: 'landing-sizes', description: htmlNote });
    console.log(htmlNote);
    expect(scriptBodies.length, '読んだ script の数').toBeGreaterThan(0);
    expect(total, `script の gzip の合計 (${scriptBodies.length} 本。大きい順 ${largest})`).toBeLessThanOrEqual(JS_BUDGET_BYTES);
    expect(externalRequests, '外部のオリジンへの要求').toEqual([]);
  });

  test('E-12 securitypolicyviolation が 0 件 (デモ・FAQ・物語・輪・ナビの操作を含む)', async ({ page }) => {
    await page.addInitScript(() => {
      window.__landingCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__landingCspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    await open(page);
    // デモ
    await pressPhoto(page, 0);
    await expect(demoStatus(page)).toContainText(String(demoScore(LANDING_COPY.demo.samples[0].nutrition)));
    // FAQ
    await faqSummaries(page).first().focus();
    await page.keyboard.press('Enter');
    await expect(faqDetails(page).first()).toHaveAttribute('open');
    // ナビ (ページの中のリンク)
    const pricingLink = siteNav(page).getByRole('link', { name: navLabel('pricing'), exact: true });
    await waitForHydration(pricingLink);
    await pricingLink.click();
    await expect(page.locator('#pricing')).toBeInViewport();
    // 物語・輪・流れの図・拡大の箱 (先頭から末尾までスクロールして、どれも画面に入れる)
    await page.evaluate(() => window.scrollTo(0, 0));
    await revealEverything(page);
    expect(await page.evaluate(() => window.__landingCspViolations ?? [])).toEqual([]);
  });

  test('E-13 JSON-LD の script が 1 つあり、type は application/ld+json、中身は @graph に Organization と WebSite', async ({ page }) => {
    await open(page);
    const scripts = page.locator('script[type="application/ld+json"]');
    await expect(scripts).toHaveCount(1);
    const json = JSON.parse((await scripts.first().textContent()) ?? '{}') as { '@graph'?: { '@type': string }[] };
    expect((json['@graph'] ?? []).map((node) => node['@type']).sort()).toEqual(['Organization', 'WebSite']);
  });

  test('E-14 見た目の記録: 1280 px と 375 px の全画面のスクリーンショットを tests/e2e/.evidence/landing/ に保存する (比較はしない)', async ({ page }, testInfo) => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const viewport of [DESKTOP, PHONE]) {
      await open(page, viewport);
      await revealEverything(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const name = `landing-${viewport.width}.png`;
      const file = path.join(EVIDENCE_DIR, name);
      await page.screenshot({ path: file, fullPage: true });
      // 結果の置き場 (tests/e2e/.output。local-ci.sh が結果と一緒に残し、CI は artifact に上げる) にも写す (整合ゲートの目視の材料)
      fs.copyFileSync(file, testInfo.outputPath(name));
    }
  });

  test('E-15 1280 px のキーボード操作: Tab を押すたびに、スキップリンク → マーク → ナビ 5 つ → ログイン → ヘッダーの無料で始める → ヒーローの無料で始める → デモを試す → デモの 1 つ目の写真のボタン の順にフォーカスが移り、どれも outline が none でない', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const expected = ['#main-content', '/', ...NAV_HREFS, '/login', SIGNUP_HREF, SIGNUP_HREF, '#demo'];
    for (const href of expected) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({ href: document.activeElement?.getAttribute('href') ?? null }));
      expect(focused.href, `Tab の先 (期待 ${href})`).toBe(href);
      expect(await activeOutlineStyle(page)).not.toBe('none');
    }
    await page.keyboard.press('Tab');
    const photoIsFocused = await pickerButtons(page).first().evaluate((element) => element === document.activeElement);
    expect(photoIsFocused, 'デモの 1 つ目の写真のボタン').toBe(true);
    expect(await activeOutlineStyle(page)).not.toBe('none');
  });

  test('E-16 アプリの WebView (is_native_app=1 の Cookie・未ログイン) でも、同じ h1 と区切りが出て、ストアへのリンクが無い', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'is_native_app', value: '1', url: baseURL ?? 'http://localhost:3000' }]);
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LANDING_COPY.hero.headlineLines.join(''));
    expect(await sectionIdsOf(page)).toEqual([...SECTION_IDS]);
    await expect(page.locator('a[href*="apps.apple.com"], a[href*="play.google.com"]')).toHaveCount(0);
    await expect(page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.primaryCta.label })).toHaveAttribute('href', SIGNUP_HREF);
  });

  for (const mode of ['no-preference', 'reduce'] as const) {
    test.describe(`E-17 ${mode}`, () => {
      test.use({ reducedMotion: mode });
      test('E-17 ヒーローは動かない 5 枚の画面 (375 px では 3 枚が見える) で、読み込みから 2 秒後に動いている Animation が無い', async ({ page }) => {
        const alts = LANDING_COPY.hero.screens.map((screen) => screen.alt);
        await open(page);
        const images = page.locator('#hero img');
        await expect(images).toHaveCount(alts.length);
        expect(await images.evaluateAll((list) => list.map((image) => image.getAttribute('alt')))).toEqual(alts);
        await page.waitForTimeout(HERO_SETTLE_MS);
        const state = await page.locator('.lp').evaluate((root) => {
          const animations = root.getAnimations({ subtree: true });
          return {
            running: animations.filter((animation) => animation.playState === 'running').length,
            infinite: animations.filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity).length,
          };
        });
        expect(state.running, '動いている Animation').toBe(0);
        expect(state.infinite, '繰り返しが無限の Animation').toBe(0);

        // 375 px: 遠くの 2 枚 (HTML の順の 4・5 枚目) は display: none で、見えるのは前と左右の 3 枚
        await open(page, PHONE);
        const visible = page.locator('#hero img').filter({ visible: true });
        await expect(visible).toHaveCount(HERO_PHONE_VISIBLE_SCREENS);
        expect(await visible.evaluateAll((list) => list.map((image) => image.getAttribute('alt')))).toEqual(alts.slice(0, HERO_PHONE_VISIBLE_SCREENS));
      });
    });
  }

  test('E-18 / の viewport は拡大を止めず (maximum-scale 5 以上)、/login の viewport は変わっていない (maximum-scale=1)', async ({ page }) => {
    const viewportContent = () => page.locator('meta[name="viewport"]').getAttribute('content');
    await page.goto('/');
    const top = (await viewportContent()) ?? '';
    expect(top).not.toContain('user-scalable=no');
    const maximumScale = Number(/maximum-scale=([0-9.]+)/.exec(top)?.[1] ?? '0');
    expect(maximumScale).toBeGreaterThanOrEqual(MIN_ALLOWED_MAXIMUM_SCALE);
    // networkidle を待たない (ログイン系の画面の後の networkidle は src/__tests__/config/e2e-auth-page-wait.test.ts が止める)
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const login = (await viewportContent()) ?? '';
    expect(login).toContain('maximum-scale=1');
  });

  test('E-19 375 px: 文字の大きさが下限を下回らず、本文の文は 16 px 以上 (lead は 17 px 以上)', async ({ page }) => {
    await open(page, PHONE);
    await waitForHydration(pickerButtons(page).first());
    await pressPhoto(page, 0);
    const first = LANDING_COPY.demo.samples[0];
    await expect(demoStatus(page)).toContainText(demoPraiseComment(first));
    const copy = LANDING_COPY;
    const chapters = Object.values(copy.chapters);
    // §5.2 の鍵: lead (17 px 以上) と本文 (16 px 以上)
    const leads = [
      copy.hero.lead,
      copy.story.lead,
      copy.demo.lead,
      copy.features.lead,
      ...chapters.map((chapter) => chapter.lead),
      copy.scenes.lead,
      copy.family.lead,
      copy.org.lead,
      copy.trust.lead,
      copy.pricing.lead,
      copy.guide.lead,
      copy.faq.lead,
      copy.finalCta.lead,
    ];
    const bodies = [
      ...copy.story.steps.map((step) => step.body),
      demoPraiseComment(first),
      ...copy.features.cards.map((card) => card.body),
      ...chapters.flatMap((chapter) => chapter.points.map((point) => point.body)),
      copy.chapters.health.disclaimer,
      ...copy.scenes.items.map((item) => item.body),
      ...copy.family.points.map((point) => point.body),
      ...copy.org.points.map((point) => point.body),
      ...copy.trust.items.map((item) => item.body),
      ...copy.pricing.plans.flatMap((plan) => (plan.body ? [plan.body] : [])),
      ...copy.pricing.limits.map((limit) => limit.body),
      ...copy.guide.points.map((point) => point.body),
      ...copy.faq.items.map((item) => item.a),
    ];
    const result = await page.evaluate(
      ({ leadTexts, bodyTexts, minFont, excerptChars }) => {
        const ownText = (element: Element) =>
          Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join('')
            .trim();
        const sizeOf = (element: Element) => parseFloat(getComputedStyle(element).fontSize);
        const small: string[] = [];
        const bySize = new Map<string, number>();
        for (const element of Array.from(document.querySelectorAll('.lp *'))) {
          const text = ownText(element);
          if (!text) continue;
          bySize.set(text, sizeOf(element));
          if (sizeOf(element) < minFont) small.push(`${element.tagName.toLowerCase()}「${text.slice(0, excerptChars)}」${sizeOf(element)}px`);
        }
        return {
          small,
          leads: leadTexts.map((text) => [text, bySize.get(text) ?? null] as const),
          bodies: bodyTexts.map((text) => [text, bySize.get(text) ?? null] as const),
        };
      },
      { leadTexts: leads, bodyTexts: bodies, minFont: MIN_FONT_PX, excerptChars: EXCERPT_CHARS },
    );
    expect(result.small, '14 px 未満の文字').toEqual([]);
    for (const [text, size] of result.leads) expect(size, `lead「${text.slice(0, EXCERPT_CHARS)}」の文字の大きさ`).toBeGreaterThanOrEqual(LEAD_FONT_PX);
    for (const [text, size] of result.bodies) expect(size, `本文「${text.slice(0, EXCERPT_CHARS)}」の文字の大きさ`).toBeGreaterThanOrEqual(BODY_FONT_PX);
  });

  test.describe('E-20 axe', () => {
    test('E-20 1280 px の開いた直後', async ({ page }) => {
      await open(page);
      await revealEverything(page);
      await expectNoAxeViolations(page, '1280 px・開いた直後');
    });

    test('E-20 1280 px で FAQ の 1 つ目を開きデモの結果を出した後', async ({ page }) => {
      await open(page);
      // FAQ は details (島でない): 1 つ目の summary を Enter で開き、1 つ目の details が open を持つのを待つ。ハイドレーションは pressPhoto が写真のボタンで待つ
      await faqSummaries(page).first().focus();
      await page.keyboard.press('Enter');
      await expect(faqDetails(page).first()).toHaveAttribute('open');
      await pressPhoto(page, 0);
      await expect(demoStatus(page)).toContainText(String(demoScore(LANDING_COPY.demo.samples[0].nutrition)));
      await revealEverything(page);
      await expectNoAxeViolations(page, '1280 px・FAQ とデモの結果');
    });

    test('E-20 375 px でページの末尾までスクロールした後', async ({ page }) => {
      await open(page, PHONE);
      await revealEverything(page);
      await expectNoAxeViolations(page, '375 px・末尾');
    });

    test.describe('reduce', () => {
      test.use({ reducedMotion: 'reduce' });
      test('E-20 reducedMotion: reduce の 1280 px の開いた直後', async ({ page }) => {
        await open(page);
        await revealEverything(page);
        await expectNoAxeViolations(page, 'reduce・1280 px');
      });
    });
  });

  test('E-21 仕組み: 1280 px では固定した端末が手順に合わせて入れ替わり、375 px では手順ごとの画面が縦に並ぶ', async ({ page }) => {
    const alts = LANDING_COPY.story.steps.map((step) => step.image.alt);

    // 1280 px: 固定した端末 (data-js の根の中の 4 枚。alt は手順の順) が見え、手順の中の画面は見えない
    await open(page, DESKTOP);
    const stage = storyStageImages(page);
    await expect(stage).toHaveCount(alts.length);
    expect(await stage.evaluateAll((images) => images.map((image) => image.getAttribute('alt')))).toEqual(alts);
    await waitForStoryStage(page);
    const stepImages = page.locator('#how li[id^="how-step-"] img');
    await expect(stepImages).toHaveCount(alts.length);
    for (let index = 0; index < alts.length; index += 1) await expect(stepImages.nth(index)).toBeHidden();
    // 手順 1 が帯にあるとき 1 枚目だけ
    await scrollCenterTo(page.locator(storyStepSelector(STORY_STEP_1)));
    await expectStoryActive(page, STORY_STEP_1 - 1);
    // 手順 3 の中心を画面の中央へ: 3 枚目だけ
    await scrollCenterTo(page.locator(storyStepSelector(STORY_STEP_3)));
    await expectStoryActive(page, STORY_STEP_3 - 1);
    // さらに画面の高さの 1/4 だけ下へスクロールしても、固定した端末の上端は同じ (sticky)
    const stageTop = () => stage.first().evaluate((image) => image.getBoundingClientRect().top);
    const topBefore = await stageTop();
    await page.evaluate((divisor) => window.scrollBy(0, window.innerHeight / divisor), STICKY_CHECK_SCROLL_DIVISOR);
    await waitForFrames(page);
    expect(Math.abs((await stageTop()) - topBefore), '固定した端末の上端の動き (px)').toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    // 末尾へ一気に移ってから戻ると、帯にある手順 (2) の画面になる
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitForFrames(page);
    await scrollCenterTo(page.locator(storyStepSelector(STORY_STEP_2)));
    await expectStoryActive(page, STORY_STEP_2 - 1);

    // 375 px: #how の中の見える img は手順の中の 4 枚で、上から順。固定した端末は見えない
    await open(page, PHONE);
    const visible = page.locator('#how img').filter({ visible: true });
    await expect(visible).toHaveCount(alts.length);
    expect(await visible.evaluateAll((list) => list.map((image) => image.getAttribute('alt')))).toEqual(alts);
    const tops = await visible.evaluateAll((list) => list.map((image) => image.getBoundingClientRect().top + window.scrollY));
    for (let index = 1; index < tops.length; index += 1) expect(tops[index], `${index + 1} 枚目は ${index} 枚目より下`).toBeGreaterThan(tops[index - 1]);
    for (let index = 0; index < alts.length; index += 1) await expect(storyStageImages(page).nth(index)).toBeHidden();
  });

  test('E-22 短いラベルは途中で折れない (デモの写真の名前・推定の栄養の名前・バッジの名前・安心の見出し・料金の見出しと札・場面の見出し・章の画面の札・拡大の札・流れの図の節・ガイドの章の名前・フッターのリンクの文)', async ({ page }) => {
    test.setTimeout(E22_TIMEOUT_MS);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const copy = LANDING_COPY;
    const chapterScreens = (['photo', 'menu', 'nutrition', 'health', 'badges', 'chat'] as const).map((id) => ({
      scope: `#${id}`,
      texts: copy.chapters[id].screens.map((screen) => screen.label),
    }));
    const targets = [
      { scope: '#demo [role="group"]', texts: copy.demo.samples.map((sample) => sample.name) },
      { scope: '#demo [role="status"]', texts: Object.values(copy.demo.nutritionLabels) },
      { scope: '#badges', texts: copy.chapters.badges.items.map((badge) => badge.name) },
      { scope: '#trust', texts: copy.trust.items.map((item) => item.title) },
      { scope: '#pricing', texts: copy.pricing.plans.flatMap((plan) => [plan.title, plan.badge]) },
      { scope: '#scenes', texts: copy.scenes.items.map((item) => item.title) },
      ...chapterScreens,
      { scope: '#photo', texts: [chapterZoom(copy.chapters.photo.zoom, 'photo').label] },
      { scope: '#menu', texts: [chapterZoom(copy.chapters.menu.zoom, 'menu').label] },
      { scope: '#how', texts: copy.story.flow.nodes.map((node) => node.label) },
      { scope: '#guide', texts: copy.guide.chapters.map((chapter) => chapter.title) },
      { scope: 'footer', texts: copy.footer.columns.flatMap((column) => column.links.map((link) => link.label)) },
    ];
    for (const width of LABEL_WIDTHS) {
      await open(page, { width, height: LABEL_HEIGHT });
      await pressPhoto(page, 0);
      await expect(demoStatus(page)).toContainText(String(demoScore(copy.demo.samples[0].nutrition)));
      await expectNoHorizontalScroll(page, `${width} px`);
      const wrapped = await page.evaluate((groups) => {
        const found: string[] = [];
        for (const group of groups) {
          for (const text of group.texts) {
            const scopes = Array.from(document.querySelectorAll(group.scope));
            let measured = false;
            for (const scope of scopes) {
              const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if ((node.textContent ?? '').trim() !== text) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                const tops = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)));
                measured = true;
                if (tops.size > 1) found.push(`${group.scope}「${text}」(${tops.size} 行)`);
              }
            }
            if (!measured) found.push(`${group.scope}「${text}」(見つからない)`);
          }
        }
        return found;
      }, targets);
      expect(wrapped, `${width} px で折れたラベル`).toEqual([]);
    }
  });

  test('E-23 戻る (ページの中): ナビの「料金」を押すと URL が /#pricing になり #pricing が画面に来て、戻ると URL が / に戻り #hero が画面にあり、文書を読み込み直さない。ナビの「機能」→ 機能のカード「AI に相談」で /#chat、戻ると /#features に戻り #features が画面にある', async ({ page }) => {
    await open(page);
    let documentLoads = 0;
    page.on('load', () => {
      documentLoads += 1;
    });
    const pricingLink = siteNav(page).getByRole('link', { name: navLabel('pricing'), exact: true });
    await waitForHydration(pricingLink);
    await pricingLink.click();
    await expect(page).toHaveURL(/\/#pricing$/);
    await expect(page.locator('#pricing')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#hero')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    expect(documentLoads, '料金 → 戻る で文書を読み込み直さない').toBe(0);

    await siteNav(page).getByRole('link', { name: navLabel('features'), exact: true }).click();
    await expect(page).toHaveURL(/\/#features$/);
    await expect(page.locator('#features')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    const chatCard = page.locator('#features').getByRole('link', { name: featureCardTitle('chat') });
    await waitForHydration(chatCard);
    await chatCard.click();
    await expect(page).toHaveURL(/\/#chat$/);
    await expect(page.locator('#chat')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    await page.goBack();
    await expect(page).toHaveURL(/\/#features$/);
    await expect(page.locator('#features')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    expect(documentLoads, '機能 → AI に相談 → 戻る で文書を読み込み直さない').toBe(0);
  });

  test('E-24 読む位置の棒: 開いた直後は scaleX が 0.05 未満、末尾までスクロールすると 0.95 以上で、途中 3 点で単調に増え、aria-hidden である', async ({ page }) => {
    await open(page);
    const bar = readingBar(page);
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute('aria-hidden', 'true');
    // 棒を書く島 (ヘッダー) のハイドレーションを待つ
    await waitForHydration(siteNav(page).getByRole('link').first());
    const readScale = async () => scaleXOf(await bar.evaluate((element) => getComputedStyle(element).transform));
    expect(await readScale(), '開いた直後').toBeLessThan(PROGRESS_START_MAX);
    let previous = await readScale();
    for (const point of PROGRESS_MID_POINTS) {
      await page.evaluate((ratio) => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * ratio), point);
      await waitForFrames(page);
      const floor = previous;
      await expect.poll(readScale, { timeout: NAVIGATION_TIMEOUT, message: `スクロールできる量の ${point} の位置` }).toBeGreaterThan(floor);
      previous = await readScale();
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitForFrames(page);
    await expect.poll(readScale, { timeout: NAVIGATION_TIMEOUT, message: '末尾' }).toBeGreaterThanOrEqual(PROGRESS_END_MIN);
  });

  test('E-25 スコアの輪: マウントの後、#nutrition が画面に入る前は ScoreRing の根に data-js があって data-in が無く、見える数字が 0 で最後の値の要素は 89、circle の stroke-dashoffset が 100 (± 0.5)。入ってから RING_DRAW_MS + 200 ms 後に見える数字が 89 で、stroke-dashoffset が 11 (± 0.5)', async ({ page }) => {
    await open(page);
    const circle = page.locator(RING_VALUE_CIRCLE);
    await expect(circle).toHaveCount(1);
    // armed (マウントで根に data-js) を待つ。開いた直後 (先頭の位置) なので #nutrition は画面に入っていない
    await expect.poll(async () => (await ringSnapshot(page)).armed, { timeout: NAVIGATION_TIMEOUT }).toBe(true);
    const armed = await ringSnapshot(page);
    expect(armed.inView, '画面に入る前の data-in').toBe(false);
    expect(armed.shown, '画面に入る前の見える数字').toBe(RING_ARMED_SHOWN);
    expect(armed.final, '最後の値の要素').toBe(String(RING_VALUE));
    expect(Math.abs(armed.dashoffset - RING_MAX), `画面に入る前の stroke-dashoffset (${armed.dashoffset})`).toBeLessThanOrEqual(RING_OFFSET_TOLERANCE);

    // 輪を画面の中央へ: data-in が付いてから RING_DRAW_MS + 200 ms 後に、最後の値と最後の形
    await scrollCenterTo(circle);
    await expect.poll(async () => (await ringSnapshot(page)).inView, { timeout: NAVIGATION_TIMEOUT }).toBe(true);
    await page.waitForTimeout(RING_DRAW_MS + DRAW_SLACK_MS);
    const drawn = await ringSnapshot(page);
    expect(drawn.shown, '描き終わった後の見える数字').toBe(String(RING_VALUE));
    expect(drawn.final).toBe(String(RING_VALUE));
    expect(Math.abs(drawn.dashoffset - RING_FINAL_OFFSET), `描き終わった後の stroke-dashoffset (${drawn.dashoffset})`).toBeLessThanOrEqual(RING_OFFSET_TOLERANCE);
  });

  test('E-26 流れの図: 画面に入る前は path の stroke-dashoffset が 1 で、入ってから --lp-dur-draw + 200 ms 後に 0', async ({ page }) => {
    await open(page);
    const flowPath = page.locator(FLOW_PATH);
    await expect(flowPath).toHaveCount(1);
    // 図を包む Reveal のマウント (JS の印) を待つ。開いた直後 (先頭の位置) なので図は画面に入っていない
    await expect.poll(() => flowPath.evaluate((element) => element.closest('[data-js]') !== null), { timeout: NAVIGATION_TIMEOUT }).toBe(true);
    const before = await dashoffsetOf(flowPath);
    expect(Math.abs(before - FLOW_PATH_LENGTH), `画面に入る前の stroke-dashoffset (${before})`).toBeLessThanOrEqual(FLOW_OFFSET_TOLERANCE);
    const drawMs = await lpDurationMs(page, '--lp-dur-draw');
    await scrollCenterTo(flowPath);
    // 描き始め (画面に入った) を待ってから、--lp-dur-draw + 200 ms
    await expect.poll(() => dashoffsetOf(flowPath), { timeout: NAVIGATION_TIMEOUT }).toBeLessThan(FLOW_PATH_LENGTH);
    await page.waitForTimeout(drawMs + DRAW_SLACK_MS);
    const after = await dashoffsetOf(flowPath);
    expect(Math.abs(after), `描き終わった後の stroke-dashoffset (${after})`).toBeLessThanOrEqual(FLOW_OFFSET_TOLERANCE);
  });

  test('E-27 横にスクロールする帯: 375 px と 1280 px のどちらでも、帯の箱 6 つ (role="region"・§5.4 の aria-label・tabindex="0") があり、375 px では 6 つとも横にスクロールでき、場面の帯は 1 枚ぶん送ると 2 枚目の左端に止まり、矢印キーでも送れて、ページは横にスクロールしない。1280 px では 6 つともスクロールしない', async ({ page }) => {
    // 375 px
    await open(page, PHONE);
    for (const name of STRIP_LABELS) {
      const box = stripRegion(page, name);
      await expect(box, name).toHaveCount(1);
      await expect(box, name).toHaveAttribute('tabindex', '0');
      const size = await box.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      expect(size.scrollWidth, `${name}: 375 px で横にスクロールできる (clientWidth ${size.clientWidth})`).toBeGreaterThan(size.clientWidth);
    }
    const scenes = stripRegion(page, SCENES_STRIP_LABEL);
    await scenes.scrollIntoViewIfNeeded();
    await advanceStripByOneItem(scenes);
    await waitForStripSettled(scenes);
    const snap = await scenes.evaluate((element) => {
      const items = element.querySelectorAll('li');
      const paddingLeft = parseFloat(getComputedStyle(element).scrollPaddingLeft) || 0;
      return { second: items[1]?.getBoundingClientRect().left ?? Number.NaN, start: element.getBoundingClientRect().left + paddingLeft };
    });
    expect(Math.abs(snap.second - snap.start), `場面の帯を 1 枚ぶん送ったときの 2 枚目の左端 (${snap.second}・箱の左端 ${snap.start})`).toBeLessThanOrEqual(SNAP_TOLERANCE_PX);
    // 箱を先頭に戻し、フォーカスして矢印キーで送る
    await scenes.evaluate((element) => element.scrollTo({ left: 0 }));
    await waitForStripSettled(scenes);
    await scenes.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scenes.evaluate((element) => element.scrollLeft), { timeout: NAVIGATION_TIMEOUT }).toBeGreaterThan(0);
    await expectNoHorizontalScroll(page, '375 px');

    // 1280 px: 箱の属性は同じで、どれもスクロールしない
    await open(page, DESKTOP);
    for (const name of STRIP_LABELS) {
      const box = stripRegion(page, name);
      await expect(box, name).toHaveCount(1);
      await expect(box, name).toHaveAttribute('tabindex', '0');
      const size = await box.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      expect(size.scrollWidth, `${name}: 1280 px ではスクロールしない (clientWidth ${size.clientWidth})`).toBeLessThanOrEqual(size.clientWidth);
    }
  });

  test('E-28 ヘッダーのナビの強調: 開いた直後は「仕組み」だけが aria-current="location" で、#pricing へ移ると「料金」だけになる', async ({ page }) => {
    await open(page);
    const nav = siteNav(page);
    const currentItems = () => nav.locator('a[aria-current]').evaluateAll((links) => links.map((link) => `${(link.textContent ?? '').trim()}=${link.getAttribute('aria-current')}`));
    await expect.poll(currentItems, { timeout: NAVIGATION_TIMEOUT }).toEqual([`${navLabel('how')}=location`]);
    const pricingLink = nav.getByRole('link', { name: navLabel('pricing'), exact: true });
    await waitForHydration(pricingLink);
    await pricingLink.click();
    await expect(page.locator('#pricing')).toBeInViewport({ timeout: NAVIGATION_TIMEOUT });
    await expect.poll(currentItems, { timeout: NAVIGATION_TIMEOUT }).toEqual([`${navLabel('pricing')}=location`]);
  });

  test('E-29 ページの中のリンクでフォーカスが移る: ナビの「料金」に Tab で移って Enter を押すと、フォーカスは section#pricing にあり、次の Tab で #pricing の中の「無料で始める」へ進む。機能のカード「AI に相談」で Enter → section#chat → 次の Tab で #chat の中の「無料で始める」。ヒーローの「デモを試す」で Enter → section#demo → 次の Tab でデモの 1 つ目の写真のボタン', async ({ page }) => {
    await open(page);
    // ページの中のリンクの先へフォーカスを移す処理 (ヘッダーの島) が動くのを待つ
    await waitForHydration(siteNav(page).getByRole('link').first());
    const primaryCta = LANDING_COPY.hero.primaryCta.label;
    /** フォーカスが区切りの section そのものにあり、その section はリングを出さない */
    const expectSectionFocused = async (id: string) => {
      await expect.poll(() => page.evaluate(() => (document.activeElement?.tagName === 'SECTION' ? document.activeElement.id : null)), { timeout: NAVIGATION_TIMEOUT }).toBe(id);
      expect(await activeOutlineStyle(page), `section#${id} の outline`).toBe('none');
    };
    /** 次の Tab の先が、その区切りの中の、その名前のリンク */
    const expectNextTabInSection = async (id: string, name: string) => {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        return { section: element?.closest('section')?.id ?? null, name: (element?.textContent ?? '').trim(), tag: element?.tagName ?? null };
      });
      expect(focused, `section#${id} の次の Tab`).toEqual({ section: id, name, tag: 'A' });
    };

    // ナビの「料金」に Tab で移って Enter
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reached = false;
    for (let step = 0; step < TAB_SEARCH_MAX && !reached; step += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.getAttribute('href') === '#pricing');
    }
    expect(reached, 'Tab でナビの「料金」に着く').toBe(true);
    await page.keyboard.press('Enter');
    await expectSectionFocused('pricing');
    await expectNextTabInSection('pricing', primaryCta);

    // 機能のカード「AI に相談」で Enter
    const chatCard = page.locator('#features').getByRole('link', { name: featureCardTitle('chat') });
    await waitForHydration(chatCard);
    await chatCard.focus();
    await page.keyboard.press('Enter');
    await expectSectionFocused('chat');
    await expectNextTabInSection('chat', primaryCta);

    // ヒーローの「デモを試す」で Enter
    await page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.secondaryCta.label }).focus();
    await page.keyboard.press('Enter');
    await expectSectionFocused('demo');
    await page.keyboard.press('Tab');
    expect(await pickerButtons(page).first().evaluate((element) => element === document.activeElement), 'section#demo の次の Tab はデモの 1 つ目の写真のボタン').toBe(true);
  });

  test.describe('E-30 axe', () => {
    test('E-30 1280 px で物語の 3 番目の手順まで進めた状態', async ({ page }) => {
      await open(page);
      await revealEverything(page);
      await waitForStoryStage(page);
      await scrollCenterTo(page.locator(storyStepSelector(STORY_STEP_3)));
      await expectStoryActive(page, STORY_STEP_3 - 1);
      await waitForTimeAnimations(page);
      await expectNoAxeViolations(page, '1280 px・物語の 3 番目の手順');
    });

    test('E-30 375 px で場面の帯を 2 枚目まで送った状態', async ({ page }) => {
      await open(page, PHONE);
      await revealEverything(page);
      const scenes = stripRegion(page, SCENES_STRIP_LABEL);
      await scenes.scrollIntoViewIfNeeded();
      await advanceStripByOneItem(scenes);
      await waitForStripSettled(scenes);
      await waitForTimeAnimations(page);
      await expectNoAxeViolations(page, '375 px・場面の帯の 2 枚目');
    });
  });

  test('E-31 拡大: 章 photo の拡大の箱は、標準では画面に入る前は縮んで透明で、入ってから元の大きさで不透明になり、中の画像は箱いっぱいにある', async ({ page }) => {
    const photoZoom = chapterZoom(LANDING_COPY.chapters.photo.zoom, 'photo');
    const photoImage = landingZoomBySrc(photoZoom.image.src);
    await open(page);
    const lens = zoomLens(page, '#photo');
    await expect(lens).toHaveCount(1);
    await expect(lens.locator('img')).toHaveAttribute('alt', photoZoom.image.alt);
    // 包む Reveal のマウント (箱の祖先に data-js) を待つ。開いた直後 (先頭の位置) なので箱は画面に入っていない
    await expect.poll(() => lens.evaluate((element) => element.closest('[data-js]') !== null), { timeout: NAVIGATION_TIMEOUT }).toBe(true);
    const before = await lensStyle(lens);
    expect(before.opacity, '画面に入る前の opacity').toBe('0');
    expect(Math.abs(scaleXOf(before.transform) - ZOOM_FROM_SCALE), `画面に入る前の transform (${before.transform})`).toBeLessThanOrEqual(ZOOM_RATIO_TOLERANCE);
    await expectLensDrawnAfterScroll(page, lens, '章 photo');
    // 箱は拡大の画像と同じ縦横比で、画像は箱の内側いっぱい (縁 1 px を含めて 2 px 以内)
    const geometry = await lens.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const image = element.querySelector('img')?.getBoundingClientRect();
      return { box: { left: box.left, top: box.top, width: box.width, height: box.height }, image: image ? { left: image.left, top: image.top, width: image.width, height: image.height } : null };
    });
    expect(Math.abs(geometry.box.width / geometry.box.height - photoImage.width / photoImage.height), `箱の縦横比 (${geometry.box.width}×${geometry.box.height})`).toBeLessThanOrEqual(ZOOM_RATIO_TOLERANCE);
    expect(geometry.image, '箱の中の画像').not.toBeNull();
    if (geometry.image) {
      expect(Math.abs(geometry.image.left - geometry.box.left), '画像の左').toBeLessThanOrEqual(ZOOM_FIT_TOLERANCE_PX);
      expect(Math.abs(geometry.image.top - geometry.box.top), '画像の上').toBeLessThanOrEqual(ZOOM_FIT_TOLERANCE_PX);
      expect(Math.abs(geometry.image.width - geometry.box.width), '画像の幅').toBeLessThanOrEqual(ZOOM_FIT_TOLERANCE_PX);
      expect(Math.abs(geometry.image.height - geometry.box.height), '画像の高さ').toBeLessThanOrEqual(ZOOM_FIT_TOLERANCE_PX);
    }
    // 章 menu の箱も同じ手順で不透明・元の大きさになる
    const menuLens = zoomLens(page, '#menu');
    await expect(menuLens).toHaveCount(1);
    await expect(menuLens.locator('img')).toHaveAttribute('alt', chapterZoom(LANDING_COPY.chapters.menu.zoom, 'menu').image.alt);
    await expectLensDrawnAfterScroll(page, menuLens, '章 menu');
  });

  test.describe('E-31 reduce', () => {
    test.use({ reducedMotion: 'reduce' });
    test('E-31 reduce: 拡大の箱は、スクロールする前から元の大きさで不透明', async ({ page }) => {
      await open(page);
      const lens = zoomLens(page, '#photo');
      await expect(lens).toHaveCount(1);
      await expect.poll(() => lens.evaluate((element) => element.closest('[data-js]') !== null), { timeout: NAVIGATION_TIMEOUT }).toBe(true);
      const style = await lensStyle(lens);
      expect(style.opacity).toBe('1');
      expect(isIdentityTransform(style.transform), `transform (${style.transform})`).toBe(true);
    });
  });
});

// JS 無し (javaScriptEnabled: false)。browser.newContext は使わない (設定の baseURL が付かないため)。ハイドレーションは待たない
test.describe('#1867 紹介ページ (/) JS 無し: E-4', () => {
  test.use({ javaScriptEnabled: false });
  test('E-4 JS 無し: summary を押すと答えが見える', async ({ page }) => {
    await open(page);
    const firstItem = LANDING_COPY.faq.items[0];
    await faqSummaries(page).first().click();
    await expect(faqDetails(page).first()).toHaveAttribute('open');
    await expect(page.locator('#faq').getByText(firstItem.a, { exact: true })).toBeVisible();
  });
});

test.describe('#1867 紹介ページ (/) JS 無し: E-31', () => {
  test.use({ javaScriptEnabled: false });
  test('E-31 JS 無し: 章 photo の拡大の画像が見え、箱は元の大きさで不透明', async ({ page }) => {
    await open(page);
    const lens = zoomLens(page, '#photo');
    await expect(lens).toHaveCount(1);
    await expect(lens.locator('img')).toBeVisible();
    const style = await lensStyle(lens);
    expect(style.opacity).toBe('1');
    expect(isIdentityTransform(style.transform), `transform (${style.transform})`).toBe(true);
  });
});
