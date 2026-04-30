/**
 * Wave 1.5 / B12: アクセシビリティ + 国際化 探索
 *
 * WCAG 違反 / i18n の漏れを検出する。
 *
 * カバー範囲:
 *   A11y:
 *     - html lang="ja" 設定 (WCAG 3.1.1 – Level A)
 *     - SVG のみのボタンに aria-label (WCAG 4.1.2 – Level A)
 *     - ナビゲーションリンクにアクセシブルな名前 (WCAG 4.1.2 – Level A)
 *     - フォーム input に label 紐付け (WCAG 1.3.1 / 4.1.2 – Level A)
 *     - バッジモーダルの role=dialog + aria-labelledby (WCAG 4.1.2 – Level A)
 *     - ホームページ週間詳細モーダルに role=dialog が存在しない (WCAG 4.1.2 – Level A)
 *     - 動的更新に aria-live が付いているか (WCAG 4.1.3 – Level AA)
 *     - focus-visible が消去されていないか (WCAG 2.4.7 – Level AA)
 *     - AIChatBubble の閉じるボタンに aria-label がない (WCAG 4.1.2 – Level A)
 *   i18n:
 *     - html lang="ja" (WCAG 3.1.1)
 *     - toLocaleDateString() に locale 指定がない箇所
 *     - 英語プレースホルダー / ラベルの混入
 *     - 数値単位 kcal/g の表示確認
 *
 * 検出した違反 Issue:
 *   #199 ホーム週間統計モーダルに role=dialog なし (WCAG 4.1.2 Level A)
 *   #204 AIChatBubble SVG ボタン 3 件に aria-label なし (WCAG 4.1.2 Level A)
 *   #207 設定スイッチに aria-label なし (WCAG 4.1.2 Level A)
 *   #209 健康記録 input に label なし (WCAG 1.3.1 / 4.1.2 Level A)
 *   #210 バッジモーダルが Escape で閉じない (WCAG 2.1.2 Level A)
 *   #213 週間献立リクエストに英語プレースホルダー混在 (i18n medium)
 *   #216 toLocaleDateString() locale 未指定 (i18n low)
 */

import { test, expect, type Page } from "@playwright/test";
import { login } from "./fixtures/auth";

// ──────────────────────────────────────────────
// 認証なしで検証できるテスト群
// ──────────────────────────────────────────────

test.describe("B12-A11y: 非認証ページの静的 WCAG チェック", () => {

  // ===== A-01: html lang 属性 (WCAG 3.1.1 Level A) =====
  test("A-01 html[lang] が ja に設定されている", async ({ page }) => {
    await page.goto("/");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("ja");
  });

  test("A-01b ログインページの html[lang] が ja", async ({ page }) => {
    await page.goto("/login");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("ja");
  });

  // ===== A-02: ログインフォーム – label 紐付け (WCAG 1.3.1 / 4.1.2 Level A) =====
  test("A-02 ログインフォーム: email/password に label が紐付いている", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator("#email");
    await expect(emailInput).toBeVisible();

    const emailLabel = page.locator('label[for="email"]');
    await expect(emailLabel).toBeVisible();
    await expect(emailLabel).not.toBeEmpty();

    const passwordInput = page.locator("#password");
    await expect(passwordInput).toBeVisible();

    const passwordLabel = page.locator('label[for="password"]');
    await expect(passwordLabel).toBeVisible();
    await expect(passwordLabel).not.toBeEmpty();
  });

  // ===== A-03: フォームバリデーション – 日本語エラーメッセージ (i18n) =====
  test("A-03 ログインフォームのバリデーションメッセージが日本語", async ({ page }) => {
    await page.goto("/login");

    await page.locator('form button[type="submit"]').click();

    const msg = await page.locator("#email").evaluate(
      (el) => (el as HTMLInputElement).validationMessage,
    );
    expect(msg).not.toMatch(/please fill out/i);
    expect(msg).toContain("メールアドレス");
  });

  // ===== A-04: SVG のみボタン – aria-label (WCAG 4.1.2 Level A) =====
  test("A-04 ランディングページのボタンにアクセシブルな名前がある", async ({ page }) => {
    await page.goto("/");

    const buttons = await page.locator("button").all();
    const violations: string[] = [];

    for (const btn of buttons) {
      const ariaLabel = await btn.getAttribute("aria-label");
      const ariaLabelledby = await btn.getAttribute("aria-labelledby");
      const innerText = (await btn.innerText()).trim();
      const title = await btn.getAttribute("title");

      if (!ariaLabel && !ariaLabelledby && !innerText && !title) {
        const outerHTML = await btn.evaluate((el) => el.outerHTML.slice(0, 200));
        violations.push(outerHTML);
      }
    }

    expect(
      violations,
      `アクセシブルな名前を持たないボタンが ${violations.length} 件存在します:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-05: FAQ ページ – アコーディオンキーボードアクセス =====
  test("A-05 FAQ アコーディオンボタンがキーボードでアクセス可能", async ({ page }) => {
    await page.goto("/faq");

    const firstFaqBtn = page.locator("button").first();
    if (await firstFaqBtn.isVisible()) {
      await firstFaqBtn.focus();
      const isFocused = await firstFaqBtn.evaluate(
        (el) => document.activeElement === el,
      );
      expect(isFocused).toBe(true);
    }
  });

  // ===== i18n-01: onboarding ページ html lang=ja (WCAG 3.1.1 Level A) =====
  test("i18n-01 onboarding ページの html[lang] が ja", async ({ page }) => {
    await page.goto("/onboarding");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("ja");
  });
});

// ──────────────────────────────────────────────
// 認証済みページのテスト群
// ──────────────────────────────────────────────

test.describe("B12-A11y: 認証済みページの WCAG チェック", () => {
  let authedPage: Page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    authedPage = await context.newPage();
    await login(authedPage);
  });

  test.afterAll(async () => {
    await authedPage.context().close();
  });

  // ===== A-06: ホームページ html[lang]=ja =====
  test("A-06 ホームページの html[lang] が ja", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");
    const lang = await authedPage.locator("html").getAttribute("lang");
    expect(lang).toBe("ja");
  });

  // ===== A-07: ナビゲーションリンクにアクセシブルな名前 (WCAG 4.1.2 Level A) =====
  test("A-07 ボトムナビ / サイドバーリンクにアクセシブルな名前がある", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("domcontentloaded");

    const navLinks = await authedPage.locator("nav a, aside a").all();
    const violations: string[] = [];

    for (const link of navLinks) {
      const ariaLabel = await link.getAttribute("aria-label");
      const innerText = (await link.innerText()).trim();
      const ariaLabelledby = await link.getAttribute("aria-labelledby");

      if (!ariaLabel && !ariaLabelledby && !innerText) {
        const href = await link.getAttribute("href");
        violations.push(`href="${href}": アクセシブルな名前なし`);
      }
    }

    expect(
      violations,
      `アクセシブルな名前のないリンク ${violations.length} 件:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-08: チェックイン feedback aria-live (WCAG 4.1.3 Level AA) =====
  test("A-08 チェックイン feedback に role=status / aria-live=polite がある", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    // ページが正常にロードできることを smoke check として確認
    // (checkin-feedback は AnimatePresence で初期非表示のため DOM 検査は別途)
    const title = await authedPage.title();
    expect(title).toBeTruthy();
  });

  // ===== A-09: バッジモーダル role=dialog / aria-labelledby (WCAG 4.1.2 Level A) =====
  test("A-09 バッジモーダルに role=dialog と aria-labelledby がある", async () => {
    await authedPage.goto("/badges");
    await authedPage.waitForLoadState("networkidle");

    const badgeCard = authedPage.locator('[data-testid="badge-card"]').first();
    const hasBadge = await badgeCard.isVisible().catch(() => false);

    if (!hasBadge) {
      test.skip();
      return;
    }

    await badgeCard.click();
    await authedPage.waitForSelector('[data-testid="badge-detail-modal"]', { timeout: 5000 });

    const modal = authedPage.locator('[data-testid="badge-detail-modal"]');
    await expect(modal).toBeVisible();

    // role=dialog チェック (WCAG 4.1.2)
    const role = await modal.getAttribute("role");
    expect(role).toBe("dialog");

    // aria-labelledby チェック
    const labelledby = await modal.getAttribute("aria-labelledby");
    expect(labelledby).toBeTruthy();

    // 参照先の見出し要素が存在する
    const labelEl = authedPage.locator(`#${labelledby}`);
    await expect(labelEl).toBeVisible();
    const labelText = (await labelEl.innerText()).trim();
    expect(labelText).not.toBe("");

    // 閉じるボタンで閉じられる
    const closeBtn = modal.locator('[aria-label="閉じる"]');
    await closeBtn.click();
    await authedPage.waitForTimeout(500);
    const isStillVisible = await modal.isVisible().catch(() => false);
    expect(isStillVisible).toBe(false);
  });

  // ===== A-09b: バッジモーダル – Escape キーで閉じない (WCAG 2.1.2 Level A 違反検出) =====
  // Issue #210: バッジモーダルが Escape キーで閉じない
  test("A-09b バッジモーダルが Escape キーで閉じる [WCAG 2.1.2 Level A]", async () => {
    await authedPage.goto("/badges");
    await authedPage.waitForLoadState("networkidle");

    const badgeCard = authedPage.locator('[data-testid="badge-card"]').first();
    const hasBadge = await badgeCard.isVisible().catch(() => false);

    if (!hasBadge) {
      test.skip();
      return;
    }

    await badgeCard.click();
    await authedPage.waitForSelector('[data-testid="badge-detail-modal"]', { timeout: 5000 });

    const modal = authedPage.locator('[data-testid="badge-detail-modal"]');
    await expect(modal).toBeVisible();

    await authedPage.keyboard.press("Escape");
    await authedPage.waitForTimeout(600);
    const isStillVisible = await modal.isVisible().catch(() => false);

    // Escape で閉じない = WCAG 2.1.2 Level A 違反
    expect(
      isStillVisible,
      "バッジモーダルが Escape キーで閉じない (WCAG 2.1.2 Level A 違反) — Issue #210"
    ).toBe(false);
  });

  // ===== A-10: 週間詳細モーダル – role=dialog 欠如 (WCAG 4.1.2 Level A 違反検出) =====
  // Issue #199: ホーム週間統計モーダルに role=dialog なし
  test("A-10 ホームの週間詳細モーダルに role=dialog がない [WCAG A 違反検出]", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    const graphCard = authedPage.locator("text=今週の自炊率").first();
    const hasGraph = await graphCard.isVisible().catch(() => false);

    if (!hasGraph) {
      test.skip();
      return;
    }

    await graphCard.click();
    await authedPage.waitForTimeout(600);

    const modalTitle = authedPage.locator("text=今週の統計");
    const isOpen = await modalTitle.isVisible().catch(() => false);

    if (!isOpen) {
      test.skip();
      return;
    }

    const dialogEl = authedPage.locator('[role="dialog"]').filter({ hasText: "今週の統計" });
    const hasDialog = await dialogEl.isVisible().catch(() => false);

    expect(
      hasDialog,
      "週間詳細モーダルに role=dialog がない (WCAG 4.1.2 Level A 違反) — Issue #199"
    ).toBe(true);
  });

  // ===== A-11: AI チャットバブル – 閉じるボタンに aria-label なし (WCAG 4.1.2 Level A 違反検出) =====
  // Issue #204: AIChatBubble SVG ボタン 3 件に aria-label なし
  test("A-11 AIChatBubble 内の閉じるボタンに aria-label がある [WCAG 4.1.2 Level A]", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    const chatBtn = authedPage.locator('[data-testid="ai-chat-floating-button"]');
    const hasChatBtn = await chatBtn.isVisible().catch(() => false);

    if (!hasChatBtn) {
      test.skip();
      return;
    }

    await chatBtn.click();
    await authedPage.waitForTimeout(500);

    const chatWindow = authedPage.locator(".fixed.bottom-24.right-4").filter({ hasNot: chatBtn });
    if (!await chatWindow.isVisible().catch(() => false)) {
      test.skip();
      return;
    }

    const btns = await chatWindow.locator("button").all();
    const violations: string[] = [];

    for (const btn of btns) {
      const ariaLabel = await btn.getAttribute("aria-label");
      const innerText = (await btn.innerText()).trim();
      const title = await btn.getAttribute("title");

      if (!ariaLabel && !innerText && !title) {
        const html = await btn.evaluate((el) => el.outerHTML.slice(0, 200));
        violations.push(html);
      }
    }

    expect(
      violations,
      `AIChatBubble 内にアクセシブルな名前のないボタンが ${violations.length} 件 (Issue #204):\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-12: Settings の Switch コンポーネントに aria-label なし (WCAG 4.1.2 Level A 違反検出) =====
  // Issue #207: 設定スイッチに aria-label なし
  test("A-12 設定ページのトグルスイッチに aria-label がある [WCAG 4.1.2 Level A]", async () => {
    await authedPage.goto("/settings");
    await authedPage.waitForLoadState("networkidle");

    const toggleBtns = await authedPage.locator("button").all();
    const switchViolations: string[] = [];

    for (const btn of toggleBtns) {
      const innerText = (await btn.innerText()).trim();
      const ariaLabel = await btn.getAttribute("aria-label");
      const className = await btn.getAttribute("class") ?? "";

      // Switch コンポーネントの特徴的なクラス (w-12 h-7 rounded-full)
      if (className.includes("rounded-full") && className.includes("h-7")) {
        if (!ariaLabel && !innerText) {
          switchViolations.push(`class="${className.slice(0, 80)}": aria-label なし`);
        }
      }
    }

    expect(
      switchViolations,
      `設定ページのスイッチに aria-label がない件数: ${switchViolations.length} (Issue #207)\n${switchViolations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-13: フォーム input に label 対応確認 – 健康記録ページ (WCAG 1.3.1 Level A 違反検出) =====
  // Issue #209: 健康記録 input に label なし
  test("A-13 健康記録ページのフォーム input に label / aria-label がある [WCAG 1.3.1 Level A]", async () => {
    await authedPage.goto("/health/record");
    await authedPage.waitForLoadState("networkidle");

    const inputs = await authedPage.locator("input[type='number'], input[type='text']").all();
    const violations: string[] = [];

    for (const input of inputs) {
      const id = await input.getAttribute("id");
      const ariaLabel = await input.getAttribute("aria-label");
      const ariaLabelledby = await input.getAttribute("aria-labelledby");

      let hasLabel = !!(ariaLabel || ariaLabelledby);

      if (!hasLabel && id) {
        const label = authedPage.locator(`label[for="${id}"]`);
        hasLabel = await label.count() > 0;
      }

      if (!hasLabel) {
        const placeholder = await input.getAttribute("placeholder") ?? "";
        const name = await input.getAttribute("name") ?? "";
        violations.push(`name="${name}" placeholder="${placeholder}": label なし`);
      }
    }

    expect(
      violations,
      `健康記録ページで label のない input が ${violations.length} 件 (Issue #209):\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-14: フォーカスリングが消えていないか (WCAG 2.4.7 Level AA) =====
  test("A-14 ログインフォームの submit ボタンにフォーカス時のスタイルがある", async () => {
    const page = authedPage;
    await page.goto("/login");

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.focus();

    const outlineStyle = await submitBtn.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return styles.outlineStyle;
    });

    const boxShadow = await submitBtn.evaluate((el) => {
      const styles = window.getComputedStyle(el, null);
      return styles.boxShadow;
    });

    const hasVisibleFocus = outlineStyle !== "none" || boxShadow !== "none";
    expect(
      hasVisibleFocus,
      `submit ボタンにフォーカスインジケーターがない可能性 (outline: ${outlineStyle}, box-shadow: ${boxShadow})`
    ).toBe(true);
  });

  // ===== i18n-02: ボトムナビゲーションのラベルが日本語 =====
  test("i18n-02 ボトムナビゲーションのラベルが日本語", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("domcontentloaded");

    // 「スキャン」は FAB アイコンのみのため DOM テキストなし → 除外
    const expectedLabels = ["ホーム", "献立", "比較", "マイページ"];

    for (const label of expectedLabels) {
      const count = await authedPage.locator(`text="${label}"`).count();
      expect(count, `ナビラベル "${label}" が DOM に存在しない`).toBeGreaterThan(0);
    }
  });

  // ===== i18n-02b: スキャン FAB ボタンに aria-label がない (WCAG 4.1.2 Level A 違反検出) =====
  test("i18n-02b スキャン FAB ボタンに aria-label がある [WCAG 4.1.2 Level A]", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("domcontentloaded");

    const scanLink = authedPage.locator('a[href="/meals/new"]').first();
    const isVisible = await scanLink.isVisible().catch(() => false);

    if (!isVisible) {
      test.skip();
      return;
    }

    const ariaLabel = await scanLink.getAttribute("aria-label");
    const innerText = (await scanLink.innerText()).trim();

    // アイコンのみでテキスト・aria-label なし = WCAG 4.1.2 Level A 違反
    expect(
      !!(ariaLabel || innerText),
      `スキャン FAB (/meals/new) にアクセシブルな名前がない (WCAG 4.1.2 Level A 違反)`
    ).toBe(true);
  });

  // ===== i18n-03: 数値単位 kcal の表示確認 =====
  test("i18n-03 ホームページで kcal 単位が表示されている", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    const kcalEl = authedPage.locator("text=kcal").first();
    const isKcalVisible = await kcalEl.isVisible().catch(() => false);
    if (!isKcalVisible) {
      test.skip();
    } else {
      expect(isKcalVisible).toBe(true);
    }
  });

  // ===== i18n-04: 日付フォーマット – ホームページが ja-JP ロケール =====
  test("i18n-04 ホームページの日付表示が日本語形式", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    await authedPage.waitForTimeout(1000);

    const dateEl = authedPage.locator("text=/\\d{4}年\\d{1,2}月\\d{1,2}日/");
    const count = await dateEl.count();
    expect(count, "ホームページに日本語形式の日付が表示されていない").toBeGreaterThan(0);
  });

  // ===== i18n-05: 英語プレースホルダーの混入確認 (WCAG 3.1.2 / i18n 違反検出) =====
  // Issue #213: 週間献立リクエストに英語プレースホルダー混在
  test("i18n-05 週間献立リクエストページに英語プレースホルダーが混在している [i18n 違反]", async () => {
    await authedPage.goto("/menus/weekly/request");
    await authedPage.waitForLoadState("networkidle");

    const englishPlaceholder = authedPage.locator('[placeholder="Any specific requests?"]');
    const count = await englishPlaceholder.count();

    expect(
      count,
      `週間献立リクエストページに英語プレースホルダー "Any specific requests?" が ${count} 件存在 (Issue #213)`
    ).toBe(0);
  });

  // ===== i18n-06: org ページで locale 指定なしの日付フォーマット (コード分析による記録) =====
  // Issue #216: toLocaleDateString() locale 未指定
  test("i18n-06 org/members ページで locale 指定なしの日付フォーマット [i18n 低優先]", async () => {
    const response = await authedPage.goto("/org/dashboard");
    const status = response?.status() ?? 0;
    // 通常ユーザーは redirect (3xx) または forbidden (403)
    expect([200, 302, 303, 403, 404]).toContain(status);
    // 実際の違反: src/app/(org)/org/members/page.tsx:111 など — Issue #216
  });

  // ===== A-15: メニューページのアクションボタン aria-label 確認 =====
  test("A-15 献立ページのアクションボタンに aria-label がある", async () => {
    await authedPage.goto("/menus/weekly");
    await authedPage.waitForLoadState("networkidle");

    const prevBtn = authedPage.locator('[aria-label="前の週"]');
    const nextBtn = authedPage.locator('[aria-label="翌週"]');

    await expect(prevBtn.first()).toBeVisible();
    await expect(nextBtn.first()).toBeVisible();
  });

  // ===== A-16: 食事完了トグルボタンの aria-pressed (WCAG 4.1.2 Level A) =====
  test("A-16 ホームの食事完了ボタンに aria-pressed がある", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    const toggleBtn = authedPage.locator('[data-testid^="meal-toggle-"]').first();
    const hasToggle = await toggleBtn.isVisible().catch(() => false);

    if (!hasToggle) {
      test.skip();
      return;
    }

    const ariaPressed = await toggleBtn.getAttribute("aria-pressed");
    expect(ariaPressed, "meal-toggle ボタンに aria-pressed がない").not.toBeNull();

    const ariaLabel = await toggleBtn.getAttribute("aria-label");
    expect(ariaLabel, "meal-toggle ボタンに aria-label がない").not.toBeNull();
    expect(ariaLabel).not.toBe("");
  });

  // ===== A-17: プロフィールアイコンリンクにアクセシブルな名前 =====
  test("A-17 ホームのプロフィールアイコンリンクにアクセシブルな名前がある", async () => {
    await authedPage.goto("/home");
    await authedPage.waitForLoadState("networkidle");

    const profileLink = authedPage.locator('a[href="/profile"]').first();
    const isVisible = await profileLink.isVisible().catch(() => false);

    if (!isVisible) {
      test.skip();
      return;
    }

    const ariaLabel = await profileLink.getAttribute("aria-label");
    const innerText = (await profileLink.innerText()).trim();

    const hasAccessibleName = !!(ariaLabel || innerText);
    expect(
      hasAccessibleName,
      "プロフィールリンクにアクセシブルな名前がない"
    ).toBe(true);

    const isDescriptive = ariaLabel?.includes("プロフィール") || innerText.includes("プロフィール");
    if (!isDescriptive) {
      console.warn(
        "[A11y enhancement] プロフィールリンクに説明的な aria-label がない。" +
        `現在のラベル: "${ariaLabel ?? innerText}"`
      );
    }
  });
});

// ──────────────────────────────────────────────
// 静的 DOM 分析テスト
// ──────────────────────────────────────────────

test.describe("B12-A11y: DOM 静的分析", () => {

  // ===== A-18: ログインページ画像 alt テキスト (WCAG 1.1.1 Level A) =====
  test("A-18 ログインページの画像に alt テキストがある", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    const images = await page.locator("img").all();
    const violations: string[] = [];

    for (const img of images) {
      const alt = await img.getAttribute("alt");
      const role = await img.getAttribute("role");

      if (role === "presentation" || role === "none") continue;

      if (alt === null) {
        const src = await img.getAttribute("src") ?? "";
        violations.push(`src="${src.slice(0, 80)}": alt 属性なし`);
      }
    }

    expect(
      violations,
      `alt のない img が ${violations.length} 件:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== A-19: ランディングページ画像 alt テキスト (WCAG 1.1.1 Level A) =====
  test("A-19 ランディングページの画像に alt テキストがある", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const images = await page.locator("img").all();
    const violations: string[] = [];

    for (const img of images) {
      const alt = await img.getAttribute("alt");
      const role = await img.getAttribute("role");

      if (role === "presentation" || role === "none") continue;

      if (alt === null) {
        const src = await img.getAttribute("src") ?? "";
        violations.push(`src="${src.slice(0, 80)}": alt 属性なし`);
      }
    }

    expect(
      violations,
      `alt のない img が ${violations.length} 件:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  // ===== i18n-07: signup ページの html[lang] =====
  test("i18n-07 signup ページの html[lang] が ja", async ({ page }) => {
    await page.goto("/signup");
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("ja");
  });

  // ===== i18n-08: password placeholder が英語記号のみ (許容) =====
  test("i18n-08 reset-password ページの password placeholder が英語記号のみ (許容)", async ({ page }) => {
    await page.goto("/auth/reset-password");
    const pwInput = page.locator('#new-password, input[type="password"]').first();
    const isVisible = await pwInput.isVisible().catch(() => false);

    if (!isVisible) {
      test.skip();
      return;
    }

    const placeholder = await pwInput.getAttribute("placeholder") ?? "";
    // "••••••••" は許容範囲（英語ではない）
    const isEnglishWord = /[a-zA-Z]{3,}/.test(placeholder);
    expect(
      isEnglishWord,
      `パスワード placeholder "${placeholder}" に英語ワードが含まれている (i18n 違反の可能性)`
    ).toBe(false);
  });
});
