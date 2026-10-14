import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// #1165 e2e がログイン・新規登録・パスワード再設定の画面で networkidle を待たないことの検査。
//
// これらの画面には、サイトキー付きでビルドしたアプリ (CI と local-ci の e2e。Cloudflare のテスト用サイトキー) では
// Turnstile のウィジェット (iframe) が常に出て、Cloudflare と通信し続ける。そのため page.waitForLoadState("networkidle") が
// 成り立たず、テストの時間切れまで待ち続ける (2026-10-10 の local-ci で 01-login.spec.ts が 3 回とも 60 秒の時間切れになった)。
// これらの画面では tests/e2e/helpers/login-form.ts の waitForLoginFormReady (フォーム・トークン・押せる送信ボタンを待つ)
// か、waitForLoadState("load") を使う。

const ROOT = path.resolve(__dirname, '../../..');
const E2E_DIR = path.join(ROOT, 'tests/e2e');
/** Playwright の出力・レポートの置き場所。検査しない */
const SKIPPED_DIRS = new Set(['.output', '.report', 'node_modules']);

/** Turnstile のウィジェットを出す Web の画面 (src/app/(auth) のログイン・新規登録・パスワード再設定) への goto */
const AUTH_PAGE_GOTO = /\.goto\(\s*[`'"][^`'"]*\/(login|signup|auth\/forgot-password|auth\/reset-password)\b/;
/** goto のあと、別の画面へ移ったとみなす操作 (ここから先は、その画面の networkidle ではない) */
const LEAVES_PAGE = /\.goto\(|\.click\(|waitForURL\(/;
/** networkidle を待つ呼び出し (waitForLoadState("networkidle") と goto / waitForURL の waitUntil: "networkidle")。コメントの文字列は対象外 */
const WAITS_NETWORK_IDLE = /waitForLoadState\(\s*['"]networkidle['"]|waitUntil:\s*['"]networkidle['"]/;
/** 時間切れを握りつぶしている networkidle 待ち (成り立たなくても先へ進むので、止まらない) は許す */
const SWALLOWED = /\.catch\(/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function listSpecFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...listSpecFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

/** ログイン系の画面を開いてから、別の画面へ移るまでの間にある networkidle 待ちを探す */
export function findNetworkIdleOnAuthPages(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  let onAuthPage = false;
  source.split('\n').forEach((text, index) => {
    const gotoAuth = AUTH_PAGE_GOTO.test(text);
    if (gotoAuth) {
      onAuthPage = true;
      // goto 自体が networkidle を待つ形 (page.goto("/login", { waitUntil: "networkidle" }))
      if (WAITS_NETWORK_IDLE.test(text)) violations.push({ file, line: index + 1, text: text.trim() });
      return;
    }
    if (!onAuthPage) return;
    if (LEAVES_PAGE.test(text)) {
      onAuthPage = false;
      return;
    }
    if (WAITS_NETWORK_IDLE.test(text) && !text.trim().startsWith('//') && !SWALLOWED.test(text)) {
      violations.push({ file, line: index + 1, text: text.trim() });
    }
  });
  return violations;
}

describe('e2e: ログイン系の画面では networkidle を待たない (#1165 Turnstile のウィジェットが通信し続けるため)', () => {
  it('検査が働く: 修正前の 01-login.spec.ts の形 (goto("/login") の直後に networkidle) を見つける', () => {
    const before = [
      'test("ログインできる", async ({ page }) => {',
      '  await page.goto("/login");',
      '  await page.waitForLoadState("networkidle");',
      '  await page.locator("#email").fill(email);',
      '});',
    ].join('\n');
    expect(findNetworkIdleOnAuthPages('sample.spec.ts', before)).toEqual([
      { file: 'sample.spec.ts', line: 3, text: 'await page.waitForLoadState("networkidle");' },
    ]);
  });

  it('検査が働く: goto の waitUntil で networkidle を待つ形・クエリ付きの URL・新規登録とパスワード再設定の画面も見つける', () => {
    const samples = [
      'await page.goto(`${BASE_URL}/login?next=/home`, { waitUntil: "networkidle" });',
      ['await page.goto("/signup");', 'await page.waitForLoadState("networkidle");'].join('\n'),
      ['await page.goto(`${baseURL}/auth/reset-password`);', 'await page.waitForLoadState("networkidle");'].join('\n'),
      ['await page.goto("/auth/forgot-password");', 'await page.waitForLoadState("networkidle");'].join('\n'),
    ];
    for (const sample of samples) {
      expect(findNetworkIdleOnAuthPages('sample.spec.ts', sample), sample).toHaveLength(1);
    }
  });

  it('ログイン後の画面 (送信のクリック・別の goto のあと) の networkidle と、時間切れを握りつぶした待ちは対象外', () => {
    const allowed = [
      ['await page.goto("/login");', 'await page.locator("button[type=submit]").click();', 'await page.waitForLoadState("networkidle");'].join('\n'),
      ['await page.goto("/login");', 'await page.goto("/home");', 'await page.waitForLoadState("networkidle");'].join('\n'),
      ['await page.goto("/auth/reset-password");', 'await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});'].join('\n'),
      ['await page.goto("/home");', 'await page.waitForLoadState("networkidle");'].join('\n'),
    ];
    for (const sample of allowed) {
      expect(findNetworkIdleOnAuthPages('sample.spec.ts', sample), sample).toEqual([]);
    }
  });

  it('tests/e2e のどのファイルも、ログイン系の画面で networkidle を待たない', () => {
    const files = listSpecFiles(E2E_DIR);
    // 走査の対象が空になって緑になるのを防ぐ (01-login.spec.ts と共通のログイン処理は必ず入る)
    const relative = files.map((file) => path.relative(ROOT, file));
    expect(relative).toEqual(
      expect.arrayContaining([
        'tests/e2e/01-login.spec.ts',
        'tests/e2e/global-setup.ts',
        'tests/e2e/fixtures/auth.ts',
        'tests/e2e/helpers/auth.ts',
      ]),
    );
    const violations = files.flatMap((file) =>
      findNetworkIdleOnAuthPages(path.relative(ROOT, file), fs.readFileSync(file, 'utf-8')),
    );
    expect(violations).toEqual([]);
  });

  it('01-login.spec.ts は、ウィジェットがトークンを出して送信ボタンが押せるのを待ってからログインし、CI ではウィジェットが無いことを許さない', () => {
    const spec = fs.readFileSync(path.join(E2E_DIR, '01-login.spec.ts'), 'utf-8');
    expect(spec).toMatch(/waitForLoginFormReady\(page,\s*\{\s*requireTurnstile:\s*REQUIRE_TURNSTILE\s*\}\)/);
    expect(spec).toContain('process.env.E2E_REQUIRE_TURNSTILE === "1"');
    // トークンが POST /api/auth/login の本文に付いて届くことも確かめる
    expect(spec).toContain('captchaToken');
  });

  it('共通のログイン処理 (global-setup・fixtures/auth.ts・helpers/auth.ts) も waitForLoginFormReady を使う', () => {
    for (const file of ['global-setup.ts', 'fixtures/auth.ts', 'helpers/auth.ts']) {
      const source = fs.readFileSync(path.join(E2E_DIR, file), 'utf-8');
      expect(source, file).toContain('await waitForLoginFormReady(page);');
    }
  });

  it('waitForLoginFormReady は networkidle を待たず、ウィジェットの ready と送信ボタンが押せることを待つ', () => {
    const helper = fs.readFileSync(path.join(E2E_DIR, 'helpers/login-form.ts'), 'utf-8');
    const code = helper
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toContain('networkidle');
    expect(code).toContain('"data-turnstile-status"');
    expect(code).toContain('toBeEnabled');
    // ウィジェットの data-testid と状態の値は、本体 (TurnstileWidget.tsx) と一致させる
    const widget = fs.readFileSync(path.join(ROOT, 'src/components/auth/TurnstileWidget.tsx'), 'utf-8');
    expect(widget).toContain('data-testid="turnstile"');
    expect(widget).toContain('data-turnstile-status={status}');
    expect(widget).toContain("setStatus('ready')");
    expect(code).toContain('TURNSTILE_TEST_ID = "turnstile"');
    expect(code).toContain('TURNSTILE_READY_STATUS = "ready"');
  });
});
