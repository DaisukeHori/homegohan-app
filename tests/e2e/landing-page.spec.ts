/**
 * #1867 紹介ページ (/) の e2e (docs/design/marketing/01-landing-site.md §16.3 の E-1〜E-22)。未ログインで本番ビルド (CSP は nonce 方式) を開く。
 *
 * 確かめるのは、構造 (セクション・見出し・ランドマーク)・操作 (デモ・FAQ・キーボード)・動きを減らす設定・拡大と幅 (320〜1280 px)・
 * 速さの予算 (LCP / CLS / JS の転送量 / 外部の要求)・CSP 違反 0・axe (WCAG 2.2 AA) の違反 0。
 * 検査は、部品の名前・LANDING_COPY の文言・セクションの id・役割とアクセシブルな名前だけを手がかりにする (実装のクラス名を前提にしない。
 * 例外として、設計書が名指しする紹介ページの根 `.lp` だけを使う: 動いている Animation を数える範囲)。
 * 速さの予算の環境変数 (LANDING_LCP_BUDGET_MS・LANDING_CLS_BUDGET・LANDING_JS_BUDGET_BYTES) はテストの実行時だけ読む (計測機の性能差のため)。
 * dev サーバでは LCP が本番より遅いので、local-ci.sh の e2e 段 (本番ビルド) で測る。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  DEMO_ANALYZING_MS,
  DEMO_NUTRITION_KEYS,
  LANDING_COPY,
  demoPraiseComment,
  demoScore,
} from '../../src/components/marketing/landing-copy';

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
/** E-22 のテスト 1 本の時間の上限 (ms)。LABEL_WIDTHS の 6 つの幅のそれぞれで、開く・ハイドレーションを待つ・デモの結果を出すので、既定 (playwright.config.ts) より長くする */
const E22_TIMEOUT_MS = 120_000;
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
/** ヒーローの立ち上がりの最長 (560 ms) より十分長い待ち (ms)。読み込みからこの時間のあとに動いている Animation が無いことを確かめる */
const HERO_SETTLE_MS = 2_000;
/** スクロールを 1 回進めたあと、IntersectionObserver と描画が追いつくのを待つ時間 (ms) */
const SCROLL_STEP_WAIT_MS = 120;
/** スクロールの最大の回数 (ページの末尾に着かないままの無限ループを防ぐ) */
const SCROLL_MAX_STEPS = 400;
/** 予算 (環境変数で上書きできる。既定は設計書 §10.1) */
const DEFAULT_LCP_BUDGET_MS = 2_500;
const DEFAULT_CLS_BUDGET = 0.1;
/**
 * JS の転送量 (gzip) の既定の予算。設計書 §10.1 は 170 KB としたが、実測 (2026-10-18・本番ビルド・Next 16.4.1) では、紹介ページの島を 1 つも持たない
 * /terms の時点で 179 KB (react-dom 74 KB・Next の実行時 44 KB・zod を含む共有の塊 32 KB ほか。ルートの layout が全ページに載せる) あり、
 * 設計の見積もり (基礎 約 100 KB) は成り立たない。紹介ページは 227 KB (島と framer-motion の分が 48 KB)。実測に約 8 % の余裕を足した値にする。
 * 計測機・版で変わるので、環境変数 LANDING_JS_BUDGET_BYTES で上書きできる。
 */
const DEFAULT_JS_BUDGET_BYTES = 240 * 1024;
const LCP_BUDGET_MS = Number(process.env.LANDING_LCP_BUDGET_MS ?? DEFAULT_LCP_BUDGET_MS);
const CLS_BUDGET = Number(process.env.LANDING_CLS_BUDGET ?? DEFAULT_CLS_BUDGET);
const JS_BUDGET_BYTES = Number(process.env.LANDING_JS_BUDGET_BYTES ?? DEFAULT_JS_BUDGET_BYTES);
/** 文字の大きさの下限 (px。globals.css の --a11y-min-font-size)・本文の下限・lead の下限 */
const MIN_FONT_PX = 14;
const BODY_FONT_PX = 16;
const LEAD_FONT_PX = 17;
/** ターゲットの大きさ (px。WCAG 2.5.8 の 24 とヘッダーのトークンの 44) */
const MIN_TARGET_PX = 24;
const HEADER_TARGET_PX = 44;
/** 見た目の記録の置き場 (比較はしない。整合ゲートで目視) */
const EVIDENCE_DIR = path.join('tests', 'e2e', '.evidence', 'landing');
/** ピンチの拡大の上限として求める maximum-scale の下限 (Lighthouse の meta-viewport の監査は 5 未満を不合格にする) */
const MIN_ALLOWED_MAXIMUM_SCALE = 5;
/** axe のタグ (docs/design/cross/05-i18n-a11y.md §5.2 の 4 つに wcag22aa を足した 5 つ) */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SIGNUP_HREF = '/signup';
const PICKER_NAME = LANDING_COPY.demo.pickerTitle;
const FAQ_FIRST_ANSWER_LIMIT_SENTENCE = '1 日にご利用いただける回数';

declare global {
  interface Window {
    __landingVitals?: { lcp: { startTime: number; inHero: boolean; element: string }[]; layoutShift: number };
    __landingCspViolations?: string[];
    __landingDemoTiming?: { pressedAt: number | null; resultAt: number | null };
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

/** 末尾までスクロールして現れ方をすべて現し、時間で進む Animation が終わるのを待つ。そのあと先頭へ戻る */
async function revealEverything(page: Page): Promise<void> {
  await scrollThroughPage(page);
  await waitForTimeAnimations(page);
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

/** ヘッダー (banner) */
const banner = (page: Page): Locator => page.getByRole('banner');

/** タグ付きの axe (違反の規則の id と対象の要素を、失敗のときに出す) */
async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
  expect(summary, `${label}: axe の違反`).toEqual([]);
}

// ─── テスト ───

test.describe('#1867 紹介ページ (/)', () => {
  for (const viewport of REVEAL_CHECK_VIEWPORTS) {
    test(`E-1 ${viewport.width}×${viewport.height}: 8 つのセクションが順にあり、末尾までスクロールすると隠れたままの要素が無い`, async ({ page }) => {
      await open(page, viewport);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(LANDING_COPY.hero.headlineLines.join(''));
      const sectionIds = await page.locator('main > section').evaluateAll((sections) => sections.map((section) => section.id));
      expect(sectionIds).toEqual(['hero', 'how', 'demo', 'features', 'badges', 'trust', 'faq', 'cta']);
      // ログインのフォームではない
      await expect(page.locator('#email')).toHaveCount(0);
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

  test('E-3 デモ: 写真を Enter で押すと分析中を経て結果が出て、フォーカスは押したボタンに残り、分析中の再選択は無視される', async ({ page }) => {
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

    // (2) 結果
    const first = demo.samples[0];
    await expect(status).toContainText(String(demoScore(first.nutrition)), { timeout: NAVIGATION_TIMEOUT });
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

  test('E-4 FAQ: ボタンは aria-expanded を持ち、Enter で開閉し、1 つ目の答えに 1 日の利用回数の上限の文がある', async ({ page }) => {
    await open(page);
    const buttons = page.locator('#faq').getByRole('button');
    await expect(buttons).toHaveCount(LANDING_COPY.faq.items.length);
    for (let index = 0; index < LANDING_COPY.faq.items.length; index += 1) {
      await expect(buttons.nth(index)).toHaveAttribute('aria-expanded', 'false');
    }
    const first = buttons.nth(0);
    await waitForHydration(first);
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    const panelId = await first.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveAttribute('role', 'region');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(FAQ_FIRST_ANSWER_LIMIT_SENTENCE);
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    // 2 つ目を開くと 1 つ目は閉じる
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    const second = buttons.nth(1);
    await second.focus();
    await page.keyboard.press('Enter');
    await expect(second).toHaveAttribute('aria-expanded', 'true');
    await expect(first).toHaveAttribute('aria-expanded', 'false');
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
    test(`E-6 ${width} px で横スクロールが無い`, async ({ page }) => {
      await open(page, { width, height: REFLOW_CHECK_HEIGHT });
      await scrollThroughPage(page, async () => {
        await expectNoHorizontalScroll(page, `${width} px`);
      });
    });
  }

  test.describe('E-7 reduced-motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('E-7 動く Animation が無く、最初から見え、デモの結果は待ち無しで最後の見え方で出る', async ({ page }) => {
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

      // デモ: 待ち無しで結果が最後の見え方で出る。押した時刻 (Enter の keydown) と、結果の箱にスコアが出た時刻をページの中で測る
      // (Playwright の待ちの既定 10 s では、reduce でも通常の待ち (DEMO_ANALYZING_MS) をする実装が通ってしまうため)
      const demo = LANDING_COPY.demo;
      const first = demo.samples[0];
      const score = String(demoScore(first.nutrition));
      const status = demoStatus(page);
      await waitForHydration(pickerButtons(page).first());
      await expect(status).not.toContainText(score);
      await status.evaluate((box, expectedScore) => {
        const timing = { pressedAt: null as number | null, resultAt: null as number | null };
        window.__landingDemoTiming = timing;
        document.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Enter' && timing.pressedAt === null) timing.pressedAt = performance.now();
          },
          { capture: true },
        );
        new MutationObserver(() => {
          if (timing.resultAt === null && (box.textContent ?? '').includes(expectedScore)) timing.resultAt = performance.now();
        }).observe(box, { subtree: true, childList: true, characterData: true });
      }, score);
      await pressPhoto(page, 0);
      await expect(status).toContainText(score);
      const timing = await page.evaluate(() => window.__landingDemoTiming ?? { pressedAt: null, resultAt: null });
      expect(timing.pressedAt, '押した時刻が取れない').not.toBeNull();
      expect(timing.resultAt, '結果が出た時刻が取れない').not.toBeNull();
      expect((timing.resultAt ?? 0) - (timing.pressedAt ?? 0), '押してから結果が出るまで (ms)').toBeLessThanOrEqual(REDUCED_RESULT_MAX_MS);
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
      await waitForHydration(page.locator('#faq').getByRole('button').first());

      // ヘッダーの見えているリンクは高さ 44 px 以上
      const headerLinks = banner(page).getByRole('link').filter({ visible: true });
      const headerCount = await headerLinks.count();
      expect(headerCount).toBeGreaterThan(0);
      for (let index = 0; index < headerCount; index += 1) {
        const box = await headerLinks.nth(index).boundingBox();
        expect(box?.height ?? 0, `ヘッダーのリンク ${index}`).toBeGreaterThanOrEqual(HEADER_TARGET_PX);
      }
      // ヒーローと最終 CTA のリンク・footer のリンク・安心のリンクは 24×24 px 以上で、focus すると outline が出る
      for (const scope of ['#hero', '#cta', 'footer', '#trust']) {
        const links = page.locator(scope).getByRole('link').filter({ visible: true });
        const count = await links.count();
        expect(count, `${scope} のリンク`).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
          const link = links.nth(index);
          const box = await link.boundingBox();
          expect(box?.width ?? 0, `${scope} のリンク ${index} の幅`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
          expect(box?.height ?? 0, `${scope} のリンク ${index} の高さ`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
          await link.focus();
          expect(await activeOutlineStyle(page), `${scope} のリンク ${index} の outline`).not.toBe('none');
        }
      }
      for (const button of [pickerButtons(page).first(), page.locator('#faq').getByRole('button').first()]) {
        await button.focus();
        expect(await activeOutlineStyle(page)).not.toBe('none');
      }

      // 固定ヘッダーがフォーカスを隠さない: 1 つ目のボタンの下端が画面の上端より上になる位置へ移り、2 つ目のボタンから Shift+Tab で戻る
      const buttons = page.locator('#faq').getByRole('button');
      const firstBottom = await buttons.nth(0).evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
      await page.evaluate((y) => window.scrollTo(0, y + 1), firstBottom);
      await buttons.nth(1).focus();
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
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('faq-button-0');
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
    // 遅れて読む画像で枠が動かないことも見るため、末尾までスクロールしてから CLS を読む
    await revealEverything(page);
    const cls = await page.evaluate(() => window.__landingVitals?.layoutShift ?? 0);
    expect(cls, 'CLS').toBeLessThanOrEqual(CLS_BUDGET);
  });

  test('E-11 / で読む同じオリジンの script を gzip した大きさの合計が予算以内で、外部のオリジンへの要求が無い', async ({ page, baseURL }) => {
    const scriptBodies: Buffer[] = [];
    const bodyReads: Promise<void>[] = [];
    const externalRequests: string[] = [];
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.origin !== origin && !url.pathname.startsWith('/_vercel/')) externalRequests.push(request.url());
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.request().resourceType() === 'script') {
        bodyReads.push(response.body().then((body) => void scriptBodies.push(body)).catch(() => undefined));
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
    expect(scriptBodies.length, '読んだ script の数').toBeGreaterThan(0);
    expect(total, `script の gzip の合計 (${scriptBodies.length} 本。大きい順 ${largest})`).toBeLessThanOrEqual(JS_BUDGET_BYTES);
    expect(externalRequests, '外部のオリジンへの要求').toEqual([]);
  });

  test('E-12 securitypolicyviolation が 0 件 (デモの操作を含む)', async ({ page }) => {
    await page.addInitScript(() => {
      window.__landingCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__landingCspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    await open(page);
    await pressPhoto(page, 0);
    await expect(demoStatus(page)).toContainText(String(demoScore(LANDING_COPY.demo.samples[0].nutrition)));
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

  test('E-14 見た目の記録: 1280 px と 375 px の全画面のスクリーンショットを tests/e2e/.evidence/landing/ に保存する (比較はしない)', async ({ page }) => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const viewport of [DESKTOP, PHONE]) {
      await open(page, viewport);
      await revealEverything(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `landing-${viewport.width}.png`), fullPage: true });
    }
  });

  test('E-15 1280 px のキーボード操作: Tab の順にフォーカスが移り、どれも outline が none でない', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const expected = ['#main-content', '/', '#features', '#how', '#badges', '#faq', '/login', SIGNUP_HREF, SIGNUP_HREF, '#demo'];
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

  test('E-16 アプリの WebView (is_native_app=1 の Cookie・未ログイン) でも、同じ h1 とセクションが出て、ストアへのリンクが無い', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'is_native_app', value: '1', url: baseURL ?? 'http://localhost:3000' }]);
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LANDING_COPY.hero.headlineLines.join(''));
    const sectionIds = await page.locator('main > section').evaluateAll((sections) => sections.map((section) => section.id));
    expect(sectionIds).toEqual(['hero', 'how', 'demo', 'features', 'badges', 'trust', 'faq', 'cta']);
    await expect(page.locator('a[href*="apps.apple.com"], a[href*="play.google.com"]')).toHaveCount(0);
    await expect(page.locator('#hero').getByRole('link', { name: LANDING_COPY.hero.primaryCta.label })).toHaveAttribute('href', SIGNUP_HREF);
  });

  for (const mode of ['no-preference', 'reduce'] as const) {
    test.describe(`E-17 ${mode}`, () => {
      test.use({ reducedMotion: mode });
      test('E-17 ヒーローは動かない 3 枚の画面で、読み込みから 2 秒後に動いている Animation が無い', async ({ page }) => {
        await open(page);
        const images = page.locator('#hero img');
        await expect(images).toHaveCount(LANDING_COPY.hero.screens.length);
        expect(await images.evaluateAll((list) => list.map((image) => image.getAttribute('alt')))).toEqual(LANDING_COPY.hero.screens.map((screen) => screen.alt));
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
    const leads = [copy.hero.lead, copy.how.lead, copy.demo.lead, copy.features.lead, copy.badges.lead, copy.faq.lead, copy.finalCta.lead];
    const bodies = [
      ...copy.how.steps.map((step) => step.body),
      demoPraiseComment(first),
      ...copy.features.cards.map((card) => card.body),
      ...copy.trust.items.map((item) => item.body),
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
      const first = page.locator('#faq').getByRole('button').first();
      await waitForHydration(first);
      await first.focus();
      await page.keyboard.press('Enter');
      await expect(first).toHaveAttribute('aria-expanded', 'true');
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

  test('E-21 使い方は動かない 3 つの手順で、1280 px では画面が横に、375 px では縦に並び、スクロールしても位置が変わらない', async ({ page }) => {
    const alts = LANDING_COPY.how.steps.map((step) => step.image.alt);
    for (const viewport of [DESKTOP, PHONE]) {
      await open(page, viewport);
      const images = page.locator('#how img');
      await expect(images).toHaveCount(alts.length);
      expect(await images.evaluateAll((list) => list.map((image) => image.getAttribute('alt')))).toEqual(alts);
      // 現れ方 (translateY) の途中の位置を測らないよう、すべて現してから測る
      await waitForHydration(pickerButtons(page).first());
      await revealEverything(page);
      const rects = await images.evaluateAll((list) => list.map((image) => ({ top: image.getBoundingClientRect().top + window.scrollY, left: image.getBoundingClientRect().left })));
      const POSITION_TOLERANCE_PX = 1;
      if (viewport.width === DESKTOP.width) {
        expect(Math.max(...rects.map((r) => r.top)) - Math.min(...rects.map((r) => r.top)), '上端の差').toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
        expect(rects[0].left).toBeLessThan(rects[1].left);
        expect(rects[1].left).toBeLessThan(rects[2].left);
      } else {
        expect(Math.max(...rects.map((r) => r.left)) - Math.min(...rects.map((r) => r.left)), '左端の差').toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
        expect(rects[0].top).toBeLessThan(rects[1].top);
        expect(rects[1].top).toBeLessThan(rects[2].top);
      }
      // どちらの幅でも、#how の上端が画面の上端にある位置と、そこから画面の高さの半分だけ下へスクロールした位置で、画面の相対の位置が同じ (固定の配置が無い)
      const relative = async () =>
        page.locator('#how').evaluate((section) => {
          const sectionTop = section.getBoundingClientRect().top;
          return Array.from(section.querySelectorAll('img')).map((image) => image.getBoundingClientRect().top - sectionTop);
        });
      await page.evaluate(() => window.scrollTo(0, (document.querySelector('#how') as HTMLElement).getBoundingClientRect().top + window.scrollY));
      const atTop = await relative();
      await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
      const afterHalf = await relative();
      afterHalf.forEach((value, index) => expect(Math.abs(value - atTop[index]), `画像 ${index} の位置`).toBeLessThanOrEqual(POSITION_TOLERANCE_PX));
    }
  });

  test('E-22 短いラベルは途中で折れない (デモの写真の名前・推定の栄養の名前・バッジの名前・安心の見出し・フッターのリンクの文)', async ({ page }) => {
    test.setTimeout(E22_TIMEOUT_MS);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const copy = LANDING_COPY;
    const targets = [
      { scope: '#demo [role="group"]', texts: copy.demo.samples.map((sample) => sample.name) },
      { scope: '#demo [role="status"]', texts: Object.values(copy.demo.nutritionLabels) },
      { scope: '#badges', texts: copy.badges.items.map((badge) => badge.name) },
      { scope: '#trust', texts: copy.trust.items.map((item) => item.title) },
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
                if (tops.size > 1) found.push(`${text} (${tops.size} 行)`);
              }
            }
            if (!measured) found.push(`${text} (見つからない)`);
          }
        }
        return found;
      }, targets);
      expect(wrapped, `${width} px で折れたラベル`).toEqual([]);
    }
  });
});
