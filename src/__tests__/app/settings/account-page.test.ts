// src/__tests__/app/settings/account-page.test.ts
// #1187: ログイン中にパスワードとメールアドレスを変更できる「アカウント」画面 (/settings/account) の契約テスト。
//
// 以前は、ログイン中に変更する手段が無かった (FAQ は「設定画面の『アカウント』から変更できます」と案内していたが、
// その画面が無かった)。ここでは画面を jsdom に描画し、次を確かめる。
//   - Google など、メール以外でログインしている人にはフォームを出さず、案内だけを出す (認証 API も呼ばない)
//   - パスワード変更 (#1720 段 C で API 経由に): 入力の検証 → POST /api/auth/password/change を 1 回呼ぶ。signInWithPassword / updateUser /
//     signOut は呼ばない (現在のパスワードの確認・履歴の照合・他の端末の失効はサーバーと GoTrue が行う。cross/16 §14.6)
//   - メールアドレス変更: updateUser({ email }, { emailRedirectTo: <origin>/auth/callback })。確認メールの案内を出す
//   - 失敗の見せ方 (通信エラー・サーバーのエラー)、二重送信の防止、パスワードをログに出さないこと
//
// GoTrue (ローカルの Supabase Auth v2.183.0) が実際にどう答えるかは、結合テスト
// tests/integration/security/account-credentials-change.test.ts が確かめる。
// @testing-library/react は未インストールのため、他の描画テストと同じく react-dom/client + act で描画する。
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (data-export.test.ts と同じ)。

import React, { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  /** 認証 API を呼んだ順 */
  calls: [] as string[],
  /** パスワードの変更 API (fetch) */
  fetch: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  clearUserScopedLocalStorage: vi.fn(),
  broadcastSignOut: vi.fn(),
  push: vi.fn(),
  /** useNativeAppMode() の結果 (アプリの中か。#1552 の案内の出し分け) */
  native: { value: false },
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: mocks.getUser,
      signInWithPassword: mocks.signInWithPassword,
      updateUser: mocks.updateUser,
      signOut: mocks.signOut,
    },
  }),
}));

// この端末はログインしたままなので、ユーザー別データの削除と他タブへのサインアウト通知は呼ばれてはいけない
vi.mock('@/lib/user-storage', () => ({
  clearUserScopedLocalStorage: mocks.clearUserScopedLocalStorage,
  broadcastSignOut: mocks.broadcastSignOut,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// アプリの中か (?mode=app・Cookie・sessionStorage の印)。既定はブラウザ (false)
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => mocks.native.value }));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

import AccountSettingsPage from '@/app/(main)/settings/account/page';
import { PASSWORD_MAX_BYTES, PASSWORD_TOO_LONG_MESSAGE } from '@homegohan/shared';

const USER_EMAIL = 'user@example.com';
const CURRENT_PASSWORD = 'CurrentPass2026x';
const NEW_PASSWORD = 'NewPass2026x';

function emailUser() {
  return { id: 'user-1', email: USER_EMAIL, app_metadata: { provider: 'email', providers: ['email'] } };
}
function googleUser() {
  return { id: 'user-2', email: 'g-user@example.com', app_metadata: { provider: 'google', providers: ['google'] } };
}
const userResult = (user: unknown) => ({ data: { user }, error: null });
/** getUser がこのユーザーを返すようにする (呼び出し順の記録 mocks.calls には残す) */
function mockSignedInAs(user: unknown) {
  mocks.getUser.mockImplementation(async () => {
    mocks.calls.push('getUser');
    return userResult(user);
  });
}

// GoTrue (v2.183.0) が実際に返したエラーの形
const networkDown = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };

const CHANGE_API_PATH = '/api/auth/password/change';
/** route の flat の本文 { error, code } の応答 (cross/16 §14.6) */
function apiError(status: number, code: string, error: string) {
  return new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });
}
function apiOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** パスワードの変更 API に送った本文 (JSON) の 1 回目 */
function sentBody(): Record<string, unknown> {
  const init = mocks.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.native.value = false;
  vi.clearAllMocks();

  mocks.getUser.mockImplementation(async () => {
    mocks.calls.push('getUser');
    return userResult(emailUser());
  });
  mocks.signInWithPassword.mockImplementation(async () => {
    mocks.calls.push('signInWithPassword');
    return { data: { user: emailUser(), session: { access_token: 'new-session' } }, error: null };
  });
  mocks.fetch.mockImplementation(async (url: string) => {
    mocks.calls.push(`fetch:${url}`);
    return apiOk();
  });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.updateUser.mockImplementation(async () => {
    mocks.calls.push('updateUser');
    return { data: { user: emailUser() }, error: null };
  });
  mocks.signOut.mockImplementation(async (options?: { scope?: string }) => {
    mocks.calls.push(`signOut:${options?.scope}`);
    return { error: null };
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 描画と操作のヘルパー ──────────────────────────────────────────────────────
async function renderPage() {
  await act(async () => {
    root.render(h(AccountSettingsPage));
  });
  // getUser の結果を待って、画面が出るまで進める
  await act(async () => {});
}

function setInputValue(input: HTMLInputElement, value: string) {
  // React の制御コンポーネントは value のセッター経由だと変更を拾えないので、プロトタイプのセッターを使う
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function field(id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`#${id} が見つかりません`);
  return input;
}

async function type(id: string, value: string) {
  await act(async () => {
    setInputValue(field(id), value);
  });
}

async function submit(formTestId: string) {
  const form = container.querySelector(`[data-testid="${formTestId}"]`);
  if (!form) throw new Error(`${formTestId} が見つかりません`);
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function submitPasswordForm(current: string, next: string, confirm: string = next) {
  await type('current-password', current);
  await type('new-password', next);
  await type('confirm-password', confirm);
  await submit('password-change-form');
}

async function submitEmailForm(value: string) {
  await type('new-email', value);
  await submit('email-change-form');
}

const text = () => container.textContent ?? '';
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const authCallCount = () =>
  mocks.signInWithPassword.mock.calls.length + mocks.updateUser.mock.calls.length + mocks.signOut.mock.calls.length;

function expectNoAuthMutation() {
  expect(authCallCount()).toBe(0);
  // パスワードの変更 API も呼んでいない
  expect(mocks.fetch).not.toHaveBeenCalled();
}

// ================================================================
// 1. 画面の構成 (メールアドレスとパスワードでログインしている人)
// ================================================================
describe('#1187 アカウント画面: メールアドレスとパスワードでログインしている人', () => {
  it('現在のメールアドレスとログイン方法を示し、パスワード変更とメールアドレス変更のフォームを出す', async () => {
    await renderPage();

    expect(container.querySelector('h1')?.textContent).toBe('アカウント');
    expect(byTestId('account-current-email')?.textContent).toBe(USER_EMAIL);
    expect(text()).toContain('メールアドレスとパスワード');

    // FAQ が案内している見出し (src/app/faq/page.tsx)
    const headings = Array.from(container.querySelectorAll('h2')).map((e) => e.textContent);
    expect(headings).toContain('パスワードを変更');
    expect(headings).toContain('メールアドレスを変更');

    expect(byTestId('password-change-form')).not.toBeNull();
    expect(byTestId('email-change-form')).not.toBeNull();
    expect(byTestId('account-external-provider-guidance')).toBeNull();
  });

  it('入力欄にラベルと autocomplete があり、パスワードマネージャと支援技術から使える', async () => {
    await renderPage();

    expect(container.querySelector('label[for="current-password"]')?.textContent).toBe('現在のパスワード');
    expect(container.querySelector('label[for="new-password"]')?.textContent).toBe('新しいパスワード');
    expect(container.querySelector('label[for="confirm-password"]')?.textContent).toContain('確認');
    expect(container.querySelector('label[for="new-email"]')?.textContent).toBe('新しいメールアドレス');

    expect(field('current-password').autocomplete).toBe('current-password');
    expect(field('new-password').autocomplete).toBe('new-password');
    expect(field('confirm-password').autocomplete).toBe('new-password');
    expect(field('new-email').autocomplete).toBe('email');
    expect(field('new-email').type).toBe('email');
    // パスワードは既定で伏せ字
    expect(field('current-password').type).toBe('password');
    expect(field('new-password').type).toBe('password');
  });

  it('開いただけでは、ログイン情報を読むだけで何も変更しない', async () => {
    await renderPage();
    expect(mocks.calls).toEqual(['getUser']);
    expectNoAuthMutation();
  });
});

// ================================================================
// 2. Google など、メール以外でログインしている人: 案内だけ
// ================================================================
describe('#1187 アカウント画面: Google でログインしている人には案内だけを出す', () => {
  it('フォームも入力欄も出さず、Google 側で管理していることと問い合わせ先を案内する', async () => {
    mockSignedInAs(googleUser());
    await renderPage();

    const guidance = byTestId('account-external-provider-guidance');
    expect(guidance).not.toBeNull();
    expect(guidance?.textContent).toContain('Googleアカウントでログインしています');
    expect(guidance?.textContent).toContain('ここでは変更できません');
    expect(guidance?.textContent).toContain('g-user@example.com');
    expect(guidance?.querySelector('a[href="/contact"]')).not.toBeNull();

    // 変更のフォームは一切出ない
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(byTestId('password-change-form')).toBeNull();
    expect(byTestId('email-change-form')).toBeNull();
    const headings = Array.from(container.querySelectorAll('h2')).map((e) => e.textContent);
    expect(headings).not.toContain('パスワードを変更');
    expect(headings).not.toContain('メールアドレスを変更');
    // ログイン方法も Google と表示する
    expect(text()).toContain('Googleアカウント');
    expect(text()).not.toContain('メールアドレスとパスワード');

    // 認証 API の更新系は呼ばない
    expect(mocks.calls).toEqual(['getUser']);
    expectNoAuthMutation();
  });

  it('provider が email 以外 (Apple・その他) や取得できない場合も、フォームは出さない', async () => {
    for (const [appMetadata, expected] of [
      [{ provider: 'apple', providers: ['apple'] }, 'Appleアカウントでログインしています'],
      [{ provider: 'github', providers: ['github'] }, '外部サービスアカウントでログインしています'],
      [{}, '外部サービスアカウントでログインしています'],
    ] as const) {
      mockSignedInAs({ id: 'u', email: 'x@example.com', app_metadata: appMetadata });
      await renderPage();

      expect(byTestId('account-external-provider-guidance')?.textContent).toContain(expected);
      expect(container.querySelector('form')).toBeNull();

      await act(async () => {
        root.render(h('div'));
      });
    }
    expectNoAuthMutation();
  });
});

// ================================================================
// 3. パスワード変更: 入力の検証 (どの認証 API も呼ばない)
// ================================================================
describe('#1187 パスワード変更: 入力の検証', () => {
  it('現在のパスワードが空なら、どの API も呼ばずに止める', async () => {
    await renderPage();
    await type('new-password', NEW_PASSWORD);
    await type('confirm-password', NEW_PASSWORD);
    await submit('password-change-form');

    expect(text()).toContain('現在のパスワードを入力してください');
    expectNoAuthMutation();
  });

  it('新しいパスワードが空なら止める', async () => {
    await renderPage();
    await type('current-password', CURRENT_PASSWORD);
    await submit('password-change-form');

    expect(text()).toContain('新しいパスワードを入力してください');
    expectNoAuthMutation();
  });

  it('新しいパスワードと確認用が一致しなければ止める', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD, `${NEW_PASSWORD}-different`);

    expect(text()).toContain('新しいパスワードと確認用のパスワードが一致しません');
    expectNoAuthMutation();
  });

  it.each([
    ['短い (8 文字未満)', 'Ab1', 'パスワードは8文字以上で入力してください'],
    ['数字だけ', '12345678', 'パスワードには英字を含めてください'],
    ['英字だけ', 'abcdefgh', 'パスワードには数字を含めてください'],
    ['長すぎる (72 バイト超 #1864)', `a1${'x'.repeat(PASSWORD_MAX_BYTES - 1)}`, PASSWORD_TOO_LONG_MESSAGE],
    ['日本語で長すぎる (26 文字 = 74 バイト #1864)', `a1${'あ'.repeat(24)}`, PASSWORD_TOO_LONG_MESSAGE],
  ])('弱いパスワード (%s) は、signup・再設定と同じ規則 (validatePassword) で止める', async (_label, weak, message) => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, weak);

    expect(text()).toContain(message);
    expectNoAuthMutation();
  });

  it('新しいパスワードが現在のパスワードと同じなら、API を呼ぶ前に止める', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, CURRENT_PASSWORD);

    expect(text()).toContain('現在のパスワードと違うものにしてください');
    expectNoAuthMutation();
  });

  it('入力に誤りがあって止めたとき、入力済みの内容は消さない', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, '12345678');

    expect(field('current-password').value).toBe(CURRENT_PASSWORD);
    expect(field('new-password').value).toBe('12345678');
  });
});

// ================================================================
// 4. パスワード変更: 現在のパスワードが違う (サーバーが断る)
// ================================================================
describe('#1720 パスワード変更: 現在のパスワードが違う', () => {
  it('400 AUTH_CURRENT_PASSWORD_MISMATCH: 「現在のパスワードが正しくありません」と出し、入力は残す', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async (url: string) => {
      mocks.calls.push(`fetch:${url}`);
      return apiError(400, 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。');
    });

    await renderPage();
    await submitPasswordForm('WrongPass2026x', NEW_PASSWORD);

    // API を 1 回呼ぶ。再認証 (signInWithPassword)・updateUser・signOut は呼ばない
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe(CHANGE_API_PATH);
    expect(sentBody()).toEqual({ current_password: 'WrongPass2026x', new_password: NEW_PASSWORD });
    expect(authCallCount()).toBe(0);
    expect(mocks.calls).toEqual(['getUser', `fetch:${CHANGE_API_PATH}`]);

    expect(text()).toContain('現在のパスワードが正しくありません');
    expect(byTestId('password-change-success')).toBeNull();
    // 直せるよう、入力は残す
    expect(field('new-password').value).toBe(NEW_PASSWORD);

    // パスワードそのものをログに出さない
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('WrongPass2026x');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(NEW_PASSWORD);
  });

  it('通信エラー (fetch の reject) は、パスワードの間違いとは言わず、通信エラーとして伝える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('通信に失敗しました');
    expect(text()).not.toContain('現在のパスワードが正しくありません');
    expect(authCallCount()).toBe(0);
    // 画面は壊れず、送信ボタンは押せる状態に戻る
    expect((container.querySelector('[data-testid="password-change-form"] button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('401 (ログインが切れた): ログインし直す案内を出す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () => apiError(401, 'AUTH_UNAUTHENTICATED', 'ログインが切れました。もう一度ログインしてください。'));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('ログインの有効期限が切れました');
    expect(text()).toContain('ログインし直して');
    expect(byTestId('password-change-success')).toBeNull();
  });
});

// ================================================================
// 5. パスワード変更: 成功
// ================================================================
describe('#1720 パスワード変更: 成功', () => {
  it('POST /api/auth/password/change を 1 回呼び、signInWithPassword / updateUser / signOut を呼ばない', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(mocks.calls).toEqual(['getUser', `fetch:${CHANGE_API_PATH}`]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(sentBody()).toEqual({ current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD });
    // 再認証のサインイン・updateUser・signOut は使わない (他の端末の失効は GoTrue が更新と同じトランザクションで行う)
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('#1864 現在のパスワードが 72 バイトを超えていても止めず、そのまま API に送る (既存の利用者を締め出さない)', async () => {
    const longCurrent = `Current1${'y'.repeat(PASSWORD_MAX_BYTES)}`;
    await renderPage();
    await submitPasswordForm(longCurrent, NEW_PASSWORD);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({ current_password: longCurrent, new_password: NEW_PASSWORD });
  });

  it('この端末はログインしたまま: ユーザー別データの削除も、他タブへのサインアウト通知も、画面遷移もしない', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('成功の表示で、ほかの端末のログインを解除したことを伝え (確認できなかった枝は無い)、入力欄を空にする', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    const success = byTestId('password-change-success');
    expect(success?.textContent).toContain('パスワードを変更しました');
    expect(success?.textContent).toContain('この端末以外のログインはすべて解除しました');
    expect(success?.textContent).not.toContain('確認できませんでした');
    expect(byTestId('password-change-others-not-signed-out-note')).toBeNull();
    expect(success?.getAttribute('role')).toBe('status');

    // パスワードを画面に残さない
    expect(field('current-password').value).toBe('');
    expect(field('new-password').value).toBe('');
    expect(field('confirm-password').value).toBe('');
    // エラーは出ていない
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('成功の表示は、次の送信の始めに消える (もう一度変更するときに前の成功を残さない)', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);
    expect(byTestId('password-change-success')).not.toBeNull();

    mocks.fetch.mockImplementationOnce(async () => apiError(400, 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await submitPasswordForm('WrongPass2026x', 'AnotherPass2026x');
    expect(byTestId('password-change-success')).toBeNull();
  });

  it('パスワードそのものをログに出さない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    const logged = JSON.stringify([...consoleError.mock.calls, ...consoleLog.mock.calls]);
    expect(logged).not.toContain(CURRENT_PASSWORD);
    expect(logged).not.toContain(NEW_PASSWORD);
  });

  it('二重に送信しても、API は 1 回だけ。処理中はボタンを押せない', async () => {
    let release!: (value: Response) => void;
    mocks.fetch.mockImplementation((url: string) => {
      mocks.calls.push(`fetch:${url}`);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });

    await renderPage();
    await type('current-password', CURRENT_PASSWORD);
    await type('new-password', NEW_PASSWORD);
    await type('confirm-password', NEW_PASSWORD);
    await submit('password-change-form'); // 1 回目: API の応答待ち
    await submit('password-change-form'); // 2 回目: 待っている間

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const button = container.querySelector('[data-testid="password-change-form"] button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('変更中');

    await act(async () => {
      release(apiOk());
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(byTestId('password-change-success')).not.toBeNull();
  });
});

// ================================================================
// 6. パスワード変更: サーバーが断る・失敗する
// ================================================================
describe('#1720 パスワード変更: サーバーの失敗', () => {
  it('422 VALID_PASSWORD_WEAK: 本文の文言を出し、GoTrue の英文は出さない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () =>
      apiError(422, 'VALID_PASSWORD_WEAK', 'このパスワードは安全性の基準を満たしていません。別のパスワードにしてください。'),
    );

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('安全性の基準を満たしていません');
    expect(text()).not.toContain('Password should be at least');
    expect(byTestId('password-change-success')).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it('422 VALID_PASSWORD_HISTORY: 「最近使ったパスワードは使えません」を出す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () =>
      apiError(422, 'VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。'),
    );

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('最近使ったパスワードは使えません');
    expect(byTestId('password-change-success')).toBeNull();
    // 直せるよう、入力は残す
    expect(field('new-password').value).toBe(NEW_PASSWORD);
  });

  it('403 AUTH_REAUTHENTICATION_REQUIRED: 「もう一度ログインしてから変更してください」を出す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () =>
      apiError(403, 'AUTH_REAUTHENTICATION_REQUIRED', '安全のため、もう一度ログインしてから変更してください。'),
    );

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('安全のため、もう一度ログインしてから変更してください');
    expect(byTestId('password-change-success')).toBeNull();
  });

  it('本文を読めない 500 は、共通の失敗の文言を出す (生の本文を出さない)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () => new Response('<html>boom</html>', { status: 500 }));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('パスワードを変更できませんでした');
    expect(text()).not.toContain('boom');
  });
});

// ================================================================
// 6.2 「ログアウトして…」の案内の指し先 (#1552)
//     アプリの中の Web の設定には「ログアウト」が出ない (#1037) ので、アプリの中ではネイティブの設定
//     (マイページの右上の歯車) とネイティブのログイン画面の「パスワードを忘れた？」を指す
// ================================================================
describe('#1552 アカウント画面: 「ログアウトして…」の案内は、アプリの中とブラウザで指し先を分ける', () => {
  it('ブラウザ: 現在のパスワードを忘れた人には、Web のログイン画面の「忘れた場合」を指す', async () => {
    await renderPage();
    const note = byTestId('password-change-forgot-current-note')?.textContent ?? '';
    expect(note).toBe(
      '現在のパスワードを思い出せないときは、いったんログアウトして、ログイン画面の「忘れた場合」からパスワードを再設定してください。',
    );
  });

  it('アプリの中 (useNativeAppMode): 現在のパスワードを忘れた人には、歯車からのログアウトと、アプリのログイン画面の「パスワードを忘れた？」を指す', async () => {
    mocks.native.value = true;
    await renderPage();
    const note = byTestId('password-change-forgot-current-note')?.textContent ?? '';
    expect(note).toBe(
      '現在のパスワードを思い出せないときは、マイページの右上の歯車 (設定) からいったんログアウトして、ログイン画面の「パスワードを忘れた？」からパスワードを再設定してください。',
    );
    expect(note).not.toContain('「忘れた場合」');
  });

  it('アプリの中 (WebView の印 window.ReactNativeWebView だけ): Cookie などの印が無くても、歯車を指す', async () => {
    (window as unknown as { ReactNativeWebView?: { postMessage: (m: string) => void } }).ReactNativeWebView = {
      postMessage: () => {},
    };
    try {
      await renderPage();
      expect(byTestId('password-change-forgot-current-note')?.textContent).toContain('「パスワードを忘れた？」');
      expect(byTestId('password-change-forgot-current-note')?.textContent).toContain('マイページの右上の歯車 (設定)');
    } finally {
      delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
    }
  });
});

// ================================================================
// 6.5 どの失敗でも、入力したパスワードをログに出さない
// ================================================================
describe('#1187 パスワード変更: どの失敗でも、入力したパスワードをコンソールに出さない', () => {
  const failures: Array<[string, () => void]> = [
    [
      '400 (現在のパスワードが違う)',
      () => mocks.fetch.mockImplementation(async () => apiError(400, 'AUTH_CURRENT_PASSWORD_MISMATCH', '現在のパスワードが正しくありません。')),
    ],
    [
      '422 (履歴と同じ)',
      () => mocks.fetch.mockImplementation(async () => apiError(422, 'VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。')),
    ],
    ['500', () => mocks.fetch.mockImplementation(async () => apiError(500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました。'))],
    ['通信の失敗 (fetch の reject)', () => mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'))],
  ];

  /** console に渡された引数を、Error も含めて文字列にする (JSON.stringify だと Error の message が落ちるため) */
  function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
    return spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
  }

  it.each(failures)('%sでも、現在のパスワードと新しいパスワードをログに出さない', async (_label, arrange) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    arrange();

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    // ログ自体は出ている (出ていなければ、下の確認は何も守らない)
    expect(consoleError).toHaveBeenCalled();
    const logged = loggedText(consoleError, consoleWarn, consoleLog);
    expect(logged).not.toContain(CURRENT_PASSWORD);
    expect(logged).not.toContain(NEW_PASSWORD);
  });
});

// ================================================================
// 7. メールアドレスの変更
// ================================================================
describe('#1187 メールアドレス変更', () => {
  it('updateUser({ email }, { emailRedirectTo: <origin>/auth/callback }) を呼び、確認メールの案内を出す', async () => {
    await renderPage();
    await submitEmailForm('  New.Address@Example.com ');

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    // 前後の空白を除き、小文字にそろえる (login / forgot-password と同じ #288)
    expect(mocks.updateUser).toHaveBeenCalledWith(
      { email: 'new.address@example.com' },
      { emailRedirectTo: `${window.location.origin}/auth/callback` },
    );
    // メールアドレスの変更では、再認証もログアウトもしない (確認メールのリンクで本人確認する)
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(['getUser', 'updateUser']);

    const sent = byTestId('email-change-sent');
    expect(sent?.getAttribute('role')).toBe('status');
    // 新しいアドレスに届くこと
    expect(sent?.textContent).toContain('確認メールを送りました');
    expect(sent?.textContent).toContain('new.address@example.com');
    // Supabase の Secure email change では、現在のアドレスにも届き、両方の確認が必要になる
    expect(sent?.textContent).toContain(USER_EMAIL);
    expect(sent?.textContent).toContain('両方の確認が必要');
    // 確認が終わるまで変わらないこと・それまでは今のアドレスで入れること
    expect(sent?.textContent).toContain('確認がすべて終わるまで、メールアドレスは変更されません');
    expect(sent?.textContent).toContain('今のメールアドレスでログインできます');
    // 入力欄は空に戻る。画面のログイン情報は確認が済むまで今のアドレスのまま
    expect(field('new-email').value).toBe('');
    expect(byTestId('account-current-email')?.textContent).toBe(USER_EMAIL);
  });

  it.each([
    ['空', '', '新しいメールアドレスを入力してください'],
    ['空白だけ', '   ', '新しいメールアドレスを入力してください'],
    ['形式が違う', 'not-an-email', 'メールアドレスの形式が正しくありません'],
    ['@ の後にドメインが無い', 'user@', 'メールアドレスの形式が正しくありません'],
    ['今と同じ', USER_EMAIL, '現在のメールアドレスと同じです'],
    ['今と同じ (大文字小文字・空白だけ違う)', ' USER@Example.COM ', '現在のメールアドレスと同じです'],
  ])('入力が正しくない (%s): どの認証 API も呼ばずに止める', async (_label, value, message) => {
    await renderPage();
    await submitEmailForm(value);

    expect(text()).toContain(message);
    expect(byTestId('email-change-sent')).toBeNull();
    expectNoAuthMutation();
  });

  it('すでに使われているメールアドレス (email_exists) は、別のアドレスを入力するよう伝え、「送りました」とは言わない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUser.mockImplementation(async () => ({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        status: 422,
        code: 'email_exists',
        message: 'A user with this email address has already been registered',
      },
    }));

    await renderPage();
    await submitEmailForm('taken@example.com');

    expect(text()).toContain('すでに別のアカウントで使われています');
    expect(byTestId('email-change-sent')).toBeNull();
    // 直せるよう、入力は残す
    expect(field('new-email').value).toBe('taken@example.com');
  });

  it('確認メールの連続送信 (429) や通信エラーは、英語のメッセージをそのまま出さず日本語で伝える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUser.mockImplementationOnce(async () => ({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        status: 429,
        code: 'over_email_send_rate_limit',
        message: 'For security purposes, you can only request this after 52 seconds.',
      },
    }));
    await renderPage();
    await submitEmailForm('new@example.com');
    expect(text()).toContain('しばらく待ってから');
    expect(text()).not.toContain('For security purposes');

    mocks.updateUser.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    await submit('email-change-form');
    expect(text()).toContain('通信に失敗しました');
    expect(byTestId('email-change-sent')).toBeNull();
  });

  it('パスワード変更とは独立している: メールアドレスの変更では、パスワード用の再認証を求めない', async () => {
    await renderPage();
    // 現在のパスワード欄が空のままでも、メールアドレスの変更は送れる
    expect(field('current-password').value).toBe('');
    await submitEmailForm('new@example.com');

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(byTestId('email-change-sent')).not.toBeNull();
  });
});

// ================================================================
// 8. ログイン情報の読み込み
// ================================================================
describe('#1187 アカウント画面: ログイン情報の読み込み', () => {
  it('読み込みに失敗したら、エラーと「もう一度読み込む」を出す。押すと再度読み込む', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getUser.mockImplementationOnce(async () => ({ data: { user: null }, error: networkDown }));

    await renderPage();
    expect(byTestId('account-load-error')).not.toBeNull();
    expect(text()).toContain('読み込めませんでした');
    expect(container.querySelector('form')).toBeNull();

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('もう一度読み込む'));
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await act(async () => {});

    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(byTestId('account-load-error')).toBeNull();
    expect(byTestId('password-change-form')).not.toBeNull();
  });

  it('ログイン状態が無い (user が null / セッションが無い) 場合は、ログイン画面への案内を出す', async () => {
    mocks.getUser.mockImplementationOnce(async () => ({ data: { user: null }, error: null }));
    await renderPage();

    const signedOut = byTestId('account-signed-out');
    expect(signedOut).not.toBeNull();
    expect(signedOut?.querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fsettings%2Faccount');
    expect(container.querySelector('form')).toBeNull();
  });

  it('getUser が AuthSessionMissingError を返したときも、ログイン画面への案内を出す', async () => {
    mocks.getUser.mockImplementationOnce(async () => ({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' },
    }));
    await renderPage();

    expect(byTestId('account-signed-out')).not.toBeNull();
    expect(byTestId('account-load-error')).toBeNull();
  });

  it('設定画面へ戻るリンクがある', async () => {
    await renderPage();
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});
