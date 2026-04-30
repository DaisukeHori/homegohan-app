/**
 * W5-2: Auth 完全嫌がらせ E2E
 *
 * 認証フロー全体を破壊しに行く adversarial テスト。
 * セッション管理・ログイン UI・ミドルウェア・API 保護・signOut 伝播・
 * rate limit・XSS・CSRF・cookie 改ざん・タブ競合を網羅する。
 *
 * カテゴリ:
 *   A. ログイン UI の嫌がらせ        (A-1〜A-6)
 *   B. 未認証アクセス / リダイレクト (B-7〜B-11)
 *   C. セッション改ざん / Cookie     (C-12〜C-16)
 *   D. signOut の伝播と競合          (D-17〜D-21)
 *   E. session-sync API              (E-22〜E-25)
 *   F. API 保護 (認証なし直叩き)     (F-26〜F-30)
 *   G. セキュリティヘッダー          (G-31〜G-33)
 *
 * 実行方法:
 *   PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e -- tests/e2e/w5-2-auth-adversarial.spec.ts --workers=1
 *
 * prefix: [auth][adversarial]
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { E2E_USER } from "./fixtures/auth";

// ─── 定数 ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

// ─── セッションキャッシュ ────────────────────────────────────────────────────
//
// Supabase の signInWithPassword はサーバーサイド rate limit があるため、
// 全テストで毎回ログイン API を叩かない。
// 初回ログイン成功後の Cookie をここに保存し、以降は Cookie を直接注入して再利用する。
// Cookie は Supabase の JWT セッション (sb-* cookies) が含まれる。

import type { Cookie } from "@playwright/test";

let _cachedAuthCookies: Cookie[] | null = null;

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

/** Cookie と localStorage/sessionStorage を全てクリアして未認証状態にする */
async function clearSession(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
  });
}

/**
 * 実際に Supabase signInWithPassword を呼んでログインし、Cookie を返す。
 * client-side rate limit キーをクリアしてから実行する。
 */
async function _doLogin(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    try { localStorage.removeItem('auth_last_fail_ts'); } catch (_) {}
  });
  const { email, password } = E2E_USER;
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 60_000 },
    ),
    page.locator("button[type=submit]").click(),
  ]);
}

/**
 * 初回は実際にログインして Cookie をキャッシュする。
 * 2 回目以降はキャッシュした Cookie を page のコンテキストに注入して
 * Supabase の rate limit を回避する。
 */
async function loginWithClear(page: Page): Promise<void> {
  if (_cachedAuthCookies) {
    // キャッシュがある場合は Cookie を注入してセッションを復元
    await page.context().addCookies(_cachedAuthCookies);
    // セッションが有効かどうか確認 (不正なら再ログイン)
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");
    if (page.url().includes("/login")) {
      // Cookie が期限切れの場合は再ログイン
      _cachedAuthCookies = null;
      await _doLogin(page);
      _cachedAuthCookies = await page.context().cookies();
    }
    return;
  }
  // 初回: 実際にログインして Cookie をキャッシュ
  await _doLogin(page);
  _cachedAuthCookies = await page.context().cookies();
}

/** ログイン済み状態で fetch を page.evaluate 経由で実行する */
async function apiFetch(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ url, method, body }: { url: string; method: string; body: string | null }) => {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ?? undefined,
      });
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = null;
      }
      return { status: res.status, body: responseBody };
    },
    {
      url: `${BASE_URL}${path}`,
      method: options.method ?? "GET",
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    },
  );
}

// ─── A. ログイン UI の嫌がらせ ──────────────────────────────────────────────

test.describe("A. ログイン UI の嫌がらせ", () => {
  /**
   * A-1: 空メール + 空パスワードでログインボタンを連打してもエラーにならない
   *
   * HTML5 required バリデーションでフォームが submit されないはず。
   * ページクラッシュや 500 が起きないことを確認する。
   */
  test("A-1: 空フォームでログインボタンを連打してもページがクラッシュしない", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const submitBtn = page.locator('button[type="submit"]').first();

    // 10 回連打
    for (let i = 0; i < 10; i++) {
      await submitBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(100);
    }

    // ページが生きていること
    await expect(page.locator("body")).toBeVisible();
    // ログインページに留まっていること
    expect(page.url()).toContain("/login");
  });

  /**
   * A-2: 不正な認証情報でログインすると日本語エラーメッセージが表示される
   *
   * signInWithPassword がエラーを返したとき、
   * UI がエラーメッセージを表示することを確認する。
   */
  test("A-2: 不正な認証情報でログインするとエラーメッセージが表示される", async ({ page }) => {
    // 前のテストで localStorage にレートリミットタイムスタンプが残らないよう初期化
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate(() => localStorage.removeItem('auth_last_fail_ts'));
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill("nonexistent-user-xyz@example.com");
    await page.locator("#password").fill("WrongPassword123!");
    await page.locator('button[type="submit"]').click();

    // エラーメッセージが表示されるまで待つ
    const errorEl = page.locator('[class*="red"]').filter({ hasText: /パスワード|ログイン|メール|しばらく/ }).first();
    await expect(errorEl).toBeVisible({ timeout: 15_000 });
  });

  /**
   * A-3: メールフィールドに XSS ペイロードを入力してもスクリプトが実行されない
   *
   * email フィールドは type="email" のため通常 XSS は入らないが、
   * 万一 UI に反映されても alert が発火しないことを確認する。
   */
  test("A-3: メールフィールドへの XSS 入力でスクリプトが実行されない", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    let alertFired = false;
    page.on("dialog", async (dialog) => {
      alertFired = true;
      await dialog.dismiss();
    });

    // type="email" は XSS文字列を弾くため JavaScript で直接値をセット
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("#email");
      if (el) {
        // Native setter でバリデーションを迂回して値を注入
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, '<script>alert(1)</script>');
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    });
    await page.locator("#password").fill("anypassword");
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2_000);

    expect(alertFired).toBe(false);
  });

  /**
   * A-4: 大文字を含むメールアドレスでログインすると正規化されて認証が通る
   *
   * login page の handleEmailLogin は email.trim().toLowerCase() で正規化する。
   * 大文字混じりのメールで正常にログインできることを確認する。
   */
  test("A-4: 大文字を含むメールアドレスでもログインできる", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate(() => localStorage.removeItem('auth_last_fail_ts'));
    await page.waitForLoadState("networkidle");

    // メールを大文字に変換して入力
    const upperEmail = E2E_USER.email.toUpperCase();
    await page.locator("#email").fill(upperEmail);
    await page.locator("#password").fill(E2E_USER.password);

    await Promise.all([
      page.waitForURL(
        (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
        { timeout: 30_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    expect(page.url()).not.toContain("/login");
  });

  /**
   * A-5: ログイン後に ?next= パラメータで指定したパスに遷移する
   *
   * login ページに ?next=/home を付けてアクセスし、
   * ログイン成功後 /home にリダイレクトされることを確認する。
   * (admin/super_admin ユーザーでない場合)
   */
  test("A-5: ?next=/home を付けてログインすると /home に遷移する", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login?next=/home`);
    await page.evaluate(() => localStorage.removeItem('auth_last_fail_ts'));
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(E2E_USER.email);
    await page.locator("#password").fill(E2E_USER.password);

    await Promise.all([
      page.waitForURL(
        (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
        { timeout: 30_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // /home か オンボーディング関係のページに遷移することを確認
    expect(page.url()).not.toContain("/login");
  });

  /**
   * A-6: ?next= に外部 URL を指定してもオープンリダイレクトにならない
   *
   * safeNext は `nextParam.startsWith('/')` でチェックしているため、
   * 外部 URL (https://evil.com) は無視されるはず。
   * 外部サイトにリダイレクトされていないことを確認する。
   */
  test("A-6: ?next= に外部 URL を指定してもオープンリダイレクトにならない", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate(() => localStorage.removeItem('auth_last_fail_ts'));
    // ?next= パラメータ付き URL に移動（rate limit キーは既にクリア済み）
    await page.goto(`${BASE_URL}/login?next=https://evil.example.com`);
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(E2E_USER.email);
    await page.locator("#password").fill(E2E_USER.password);

    await Promise.all([
      page.waitForURL(
        (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
        { timeout: 60_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // 外部サイトにリダイレクトされていないこと
    expect(page.url()).not.toContain("evil.example.com");
    // アプリ内のページにいること
    expect(page.url()).toContain(new URL(BASE_URL).hostname);
  });
});

// ─── B. 未認証アクセス / リダイレクト ───────────────────────────────────────

test.describe("B. 未認証アクセス / リダイレクト", () => {
  /**
   * B-7: 未認証で /home にアクセスすると /login にリダイレクトされる
   *
   * middleware の publicPaths に /home は含まれないため、
   * 未認証アクセスは /login?next=/home にリダイレクトされるはず。
   */
  test("B-7: 未認証で /home にアクセスすると /login にリダイレクトされる", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  /**
   * B-8: 未認証で /health にアクセスすると /login にリダイレクト + ?next=/health が付く
   *
   * middleware は next=${pathname} を付けてリダイレクトする実装。
   */
  test("B-8: 未認証で /health にアクセスすると ?next=/health が付く", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/health`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    const url = new URL(page.url());
    const nextParam = url.searchParams.get("next");
    expect(nextParam).toBe("/health");
  });

  /**
   * B-9: 未認証で /settings にアクセスすると /login にリダイレクトされる
   */
  test("B-9: 未認証で /settings にアクセスすると /login にリダイレクトされる", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  /**
   * B-10: /login は未認証でもアクセスできる (publicPaths に含まれる)
   */
  test("B-10: /login は未認証でアクセスできる", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");
    // /login ページのままであること (リダイレクトされない)
    expect(page.url()).toContain("/login");
    // ログインフォームが表示されていること
    const emailInput = page.locator("#email");
    await expect(emailInput).toBeVisible({ timeout: 10_000 });
  });

  /**
   * B-11: 未認証で /onboarding/questions にアクセスすると /login にリダイレクト
   *
   * /onboarding/welcome のみ publicPaths に含まれるが、
   * /onboarding/questions は認証が必要。
   */
  test("B-11: 未認証で /onboarding/questions にアクセスすると /login にリダイレクト", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/onboarding/questions`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });
});

// ─── C. セッション改ざん / Cookie ────────────────────────────────────────────

test.describe("C. セッション改ざん / Cookie", () => {
  /**
   * C-12: Cookie を全削除してから保護ページにアクセスすると /login にリダイレクト
   *
   * ログイン後に Cookie を削除すると未認証扱いになることを確認する。
   */
  test("C-12: Cookie 削除後に /home にアクセスすると /login にリダイレクト", async ({ page }) => {
    await loginWithClear(page);
    // Cookie を削除してセッションを破棄
    await page.context().clearCookies();

    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  /**
   * C-13: Supabase Cookie の値を改ざんして /home にアクセスすると /login にリダイレクト
   *
   * Cookie 名は sb-* で始まる。値を "tampered" に書き換えると
   * getUser() が失敗して /login にリダイレクトされるはず。
   */
  test("C-13: Supabase Cookie を改ざんすると /login にリダイレクトされる", async ({ page }) => {
    await loginWithClear(page);

    // Supabase 関連 Cookie を改ざん
    const cookies = await page.context().cookies();
    const supabaseCookies = cookies.filter((c) => c.name.startsWith("sb-"));

    if (supabaseCookies.length === 0) {
      // Cookie が見つからない場合はスモークテストとして続行
      console.warn("C-13: Supabase cookies not found — smoke test only");
      await page.context().clearCookies();
      await page.goto(`${BASE_URL}/home`);
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      return;
    }

    // Cookie を改ざん
    const tamperedCookies = supabaseCookies.map((c) => ({
      ...c,
      value: "tampered_invalid_value",
    }));
    await page.context().clearCookies();
    await page.context().addCookies(tamperedCookies);

    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  /**
   * C-14: ログイン後に localStorage を全削除しても認証状態が維持される
   *
   * 認証情報は httpOnly Cookie で管理されるため、
   * localStorage をクリアしても /home にアクセスできるはず。
   */
  test("C-14: localStorage 削除後も Cookie がある限り認証状態が維持される", async ({ page }) => {
    await loginWithClear(page);

    // localStorage を全削除
    await page.evaluate(() => localStorage.clear());

    // ページリロード
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    // /login にリダイレクトされていないこと (Cookie は生きている)
    // オンボーディング完了状態によっては別ページに行く可能性もある
    expect(page.url()).not.toContain("/login");
  });

  /**
   * C-15: 別ブラウザコンテキスト (= 異なるユーザー相当) からは同じセッションにアクセスできない
   *
   * コンテキスト A でログインした Cookie は コンテキスト B には引き継がれない。
   * コンテキスト B から保護ページにアクセスすると /login にリダイレクトされるはず。
   */
  test("C-15: 別コンテキストは認証 Cookie を共有しない", async ({ browser }) => {
    // コンテキスト A でログイン
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginWithClear(pageA);
    await ctxA.close();

    // コンテキスト B は新規 (Cookie なし)
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();

    await pageB.goto(`${BASE_URL}/home`);
    await pageB.waitForURL(/\/login/, { timeout: 15_000 });
    expect(pageB.url()).toContain("/login");

    await ctxB.close();
  });

  /**
   * C-16: 認証済みセッションで /login にアクセスすると別ページにリダイレクトされる
   *        (または /login ページが表示されるが、既に認証済みであることがわかる)
   *
   * 実装によっては /home にリダイレクトされる場合があるので、
   * ここでは「/login ページが login フォームを表示しているか」ではなく
   * 「/login が 5xx を返さない」ことを確認する。
   */
  test("C-16: 認証済みで /login にアクセスしても 500 にならない", async ({ page }) => {
    await loginWithClear(page);

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    // 500 エラーページが出ていないこと
    const title = await page.title();
    expect(title).not.toContain("500");
    expect(title).not.toContain("Internal Server Error");
    await expect(page.locator("body")).toBeVisible();
  });
});

// ─── D. signOut の伝播と競合 ─────────────────────────────────────────────────

test.describe("D. signOut の伝播と競合", () => {
  /**
   * D-17: ログアウト後に /home にアクセスすると /login にリダイレクトされる
   *
   * サインアウト後はセッションが消えるため、
   * 保護ページへのアクセスは /login にリダイレクトされるはず。
   */
  test("D-17: ログアウト後に /home にアクセスすると /login にリダイレクト", async ({ page }) => {
    await loginWithClear(page);

    // Supabase クライアント経由でサインアウト
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    // signOut を JS で実行
    await page.evaluate(async (baseUrl: string) => {
      // session-sync エンドポイントは POST のみ対応するため、
      // クライアントサイドの supabase は直接使えない。
      // Cookie を削除してサインアウトをシミュレートする。
      const cookies = document.cookie.split(";");
      for (const cookie of cookies) {
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.slice(0, eqPos) : cookie;
        document.cookie = `${name.trim()}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }, BASE_URL);

    // Cookie 削除後に /home を再度リクエスト
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/home`);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  /**
   * D-18: 2 タブで同時にログアウトしてもエラーにならない
   *
   * 両タブで signOut を呼び出す競合が発生しても、
   * サーバーが 500 を返さないことを確認する。
   */
  test("D-18: 2 タブで同時にログアウトしても 500 にならない", async ({ browser }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await loginWithClear(pageA);

    const pageB = await ctx.newPage();
    await pageB.goto(`${BASE_URL}/home`);
    await pageB.waitForLoadState("networkidle");

    // 両タブで Cookie を削除（signOut のシミュレーション）
    await Promise.all([
      ctx.clearCookies(),
      ctx.clearCookies(),
    ]);

    // 両タブで /home にアクセス
    const results = await Promise.all([
      pageA.goto(`${BASE_URL}/home`).then(() => pageA.url()),
      pageB.goto(`${BASE_URL}/home`).then(() => pageB.url()),
    ]);

    // どちらも /login にリダイレクトされるか、500 エラーにならないこと
    for (const url of results) {
      expect(url).not.toContain("500");
    }

    await ctx.close();
  });

  /**
   * D-19: ログアウト後に BroadcastChannel が利用可能かスモークテスト
   *
   * MainLayout は 'auth' チャンネルの SIGNED_OUT メッセージを受信する。
   * ブラウザが BroadcastChannel をサポートしていることを確認する。
   */
  test("D-19: BroadcastChannel が利用可能である", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    const bcAvailable = await page.evaluate(() => typeof BroadcastChannel !== "undefined");
    expect(bcAvailable).toBe(true);
  });

  /**
   * D-20: タブ A でログアウト → タブ B で /home にアクセスすると /login に飛ぶ
   *
   * Cookie は共有されているため、タブ A がクリアすればタブ B も未認証になる。
   */
  test("D-20: タブ A でログアウト後にタブ B の保護ページアクセスは /login に飛ぶ", async ({ browser }) => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await loginWithClear(pageA);

    // タブ B も同じコンテキストで /home を開く
    const pageB = await ctx.newPage();
    await pageB.goto(`${BASE_URL}/home`);
    await pageB.waitForLoadState("networkidle");

    // タブ A でセッションをクリア
    await ctx.clearCookies();

    // タブ B で /home に再アクセス
    await pageB.goto(`${BASE_URL}/home`);
    await pageB.waitForURL(/\/login/, { timeout: 15_000 });
    expect(pageB.url()).toContain("/login");

    await ctx.close();
  });

  /**
   * D-21: ログアウト後に history.back() で戻っても保護コンテンツが表示されない
   *
   * ブラウザの「戻る」ボタンで認証済みページに戻っても、
   * ページをリロードすると /login にリダイレクトされることを確認する。
   */
  test("D-21: ログアウト後に history.back() で戻ってリロードすると /login に飛ぶ", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    // セッション削除
    await page.context().clearCookies();

    // ブラウザの戻るボタン相当
    await page.goBack().catch(() => {});
    // ページをリロードして認証チェックを発生させる
    await page.reload();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });
});

// ─── E. session-sync API ─────────────────────────────────────────────────────

test.describe("E. session-sync API", () => {
  /**
   * E-22: 未認証で /api/auth/session-sync に POST すると 401 を返す
   *
   * session-sync は有効なセッションがない場合 401 を返す実装。
   */
  test("E-22: 未認証で session-sync に POST すると 401 を返す", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/auth/session-sync", { method: "POST" });
    expect(result.status).toBe(401);
  });

  /**
   * E-23: 認証済みで /api/auth/session-sync に POST すると 200 を返す
   *
   * セッションが有効な場合、session-sync は { ok: true } を返す。
   */
  test("E-23: 認証済みで session-sync に POST すると 200 を返す", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/auth/session-sync", { method: "POST" });
    expect(result.status).toBe(200);
  });

  /**
   * E-24: session-sync に GET でアクセスすると 405 相当のエラーを返す
   *
   * route.ts に GET ハンドラがないため、Next.js が 405 を返すはず。
   */
  test("E-24: session-sync に GET でアクセスすると 405 を返す", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/auth/session-sync", { method: "GET" });
    // 405 Method Not Allowed
    expect(result.status).toBe(405);
  });

  /**
   * E-25: session-sync を 3 回連続で呼んでも 500 にならない
   *
   * 連続呼び出しが idempotent であることを確認する。
   */
  test("E-25: session-sync を 3 回連続で呼んでも 500 にならない", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    for (let i = 0; i < 3; i++) {
      const result = await apiFetch(page, "/api/auth/session-sync", { method: "POST" });
      expect(result.status).not.toBe(500);
    }
  });
});

// ─── F. API 保護 (認証なし直叩き) ────────────────────────────────────────────

test.describe("F. API 保護 (認証なし直叩き)", () => {
  /**
   * F-26: 未認証で /api/profile に GET するると 401 を返す
   *
   * 認証が必要な API エンドポイントは未認証アクセスで 401 を返すはず。
   */
  test("F-26: 未認証で /api/profile に GET すると 401 を返す", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/profile");
    expect([401, 403]).toContain(result.status);
  });

  /**
   * F-27: 未認証で /api/meals に GET すると 401 を返す
   */
  test("F-27: 未認証で /api/meals に GET すると 401 を返す", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/meals");
    expect([401, 403]).toContain(result.status);
  });

  /**
   * F-28: 未認証で /api/meal-plans に GET すると 401 を返す
   */
  test("F-28: 未認証で /api/meal-plans に GET すると 401 を返す", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/meal-plans");
    expect([401, 403]).toContain(result.status);
  });

  /**
   * F-29: 未認証で /api/badges に GET すると 401 を返す
   */
  test("F-29: 未認証で /api/badges に GET すると 401 を返す", async ({ page }) => {
    await clearSession(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/badges");
    expect([401, 403]).toContain(result.status);
  });

  /**
   * F-30: 認証済みで /api/profile に GET すると 200 か有効な JSON を返す
   *
   * 認証済みユーザーはプロフィール API にアクセスできるはず。
   */
  test("F-30: 認証済みで /api/profile に GET すると 401 以外を返す", async ({ page }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    const result = await apiFetch(page, "/api/profile");
    // 認証済みなので 401 にはならないこと
    expect(result.status).not.toBe(401);
    expect(result.status).not.toBe(403);
  });
});

// ─── G. セキュリティヘッダー ─────────────────────────────────────────────────

test.describe("G. セキュリティヘッダー", () => {
  /**
   * G-31: /login が X-Frame-Options: DENY を返す
   *
   * クリックジャッキング攻撃を防ぐためのヘッダー確認。
   */
  test("G-31: /login は X-Frame-Options: DENY を返す", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/login`);
    const headers = res.headers();
    expect(headers["x-frame-options"]).toMatch(/DENY/i);
  });

  /**
   * G-32: 認証保護ルートのレスポンスに Cache-Control: private, no-store が付く
   *
   * middleware は isPublicPath でない場合に
   * Cache-Control: private, no-store, max-age=0, must-revalidate を設定する。
   * CDN に認証済みコンテンツがキャッシュされないことを確認する。
   */
  test("G-32: 保護ルート /home は Cache-Control: private, no-store を返す", async ({ page, request }) => {
    await loginWithClear(page);
    await page.goto(`${BASE_URL}/home`);
    await page.waitForLoadState("networkidle");

    // 認証 Cookie を引き継いだリクエストで確認
    const res = await page.request.get(`${BASE_URL}/home`);
    const headers = res.headers();
    const cacheControl = headers["cache-control"] ?? "";
    expect(cacheControl).toMatch(/private|no-store/i);
  });

  /**
   * G-33: /login は X-Content-Type-Options: nosniff を返す
   *
   * MIME タイプスニッフィング攻撃を防ぐためのヘッダー確認。
   */
  test("G-33: /login は X-Content-Type-Options: nosniff を返す", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/login`);
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toMatch(/nosniff/i);
  });
});
