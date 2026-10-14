// src/__tests__/app/settings/account-page.test.ts
// #1187: ログイン中にパスワードとメールアドレスを変更できる「アカウント」画面 (/settings/account) の契約テスト。
//
// 以前は、ログイン中に変更する手段が無かった (FAQ は「設定画面の『アカウント』から変更できます」と案内していたが、
// その画面が無かった)。ここでは画面を jsdom に描画し、次を確かめる。
//   - Google など、メール以外でログインしている人にはフォームを出さず、案内だけを出す (認証 API も呼ばない)
//   - パスワード変更: 入力の検証 → 現在のパスワードで再認証 (本人のメールアドレスで signInWithPassword) →
//     updateUser({ password }) → signOut({ scope: 'others' }) の順。現在のパスワードが違えば更新しない
//   - メールアドレス変更: updateUser({ email }, { emailRedirectTo: <origin>/auth/callback })。確認メールの案内を出す
//   - 失敗の見せ方 (通信エラー・サーバーのエラー・signOut だけの失敗)、二重送信の防止、パスワードをログに出さないこと
//
// GoTrue (ローカルの Supabase Auth v2.183.0) が実際にどう答えるかは、結合テスト
// tests/integration/security/account-credentials-change.test.ts が確かめる。
// @testing-library/react は未インストールのため、他の描画テストと同じく react-dom/client + act で描画する。
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (data-export.test.ts と同じ)。

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  /** 認証 API を呼んだ順 */
  calls: [] as string[],
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  clearUserScopedLocalStorage: vi.fn(),
  broadcastSignOut: vi.fn(),
  push: vi.fn(),
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
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

import AccountSettingsPage from '@/app/(main)/settings/account/page';

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
const invalidCredentials = { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' };
const networkDown = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();

  mocks.getUser.mockImplementation(async () => {
    mocks.calls.push('getUser');
    return userResult(emailUser());
  });
  mocks.signInWithPassword.mockImplementation(async () => {
    mocks.calls.push('signInWithPassword');
    return { data: { user: emailUser(), session: { access_token: 'new-session' } }, error: null };
  });
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
  ])('弱いパスワード (%s) は、signup・再設定と同じ規則 (validatePassword) で止める', async (_label, weak, message) => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, weak);

    expect(text()).toContain(message);
    expectNoAuthMutation();
  });

  it('新しいパスワードが現在のパスワードと同じなら、再認証の前に止める', async () => {
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
// 4. パスワード変更: 現在のパスワードが違う
// ================================================================
describe('#1187 パスワード変更: 現在のパスワードが違う (再認証の失敗)', () => {
  it('「現在のパスワードが正しくありません」と出し、updateUser も signOut もしない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signInWithPassword.mockImplementation(async () => {
      mocks.calls.push('signInWithPassword');
      return { data: { user: null, session: null }, error: invalidCredentials };
    });

    await renderPage();
    await submitPasswordForm('WrongPass2026x', NEW_PASSWORD);

    // 再認証は、画面に出ている本人のメールアドレスで行う (利用者が入力した別のアドレスではない)
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: USER_EMAIL, password: 'WrongPass2026x' });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(['getUser', 'signInWithPassword']);

    expect(text()).toContain('現在のパスワードが正しくありません');
    expect(byTestId('password-change-success')).toBeNull();
    // 直せるよう、入力は残す
    expect(field('new-password').value).toBe(NEW_PASSWORD);

    // パスワードそのものをログに出さない
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('WrongPass2026x');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(NEW_PASSWORD);
  });

  it('再認証が通信エラーで失敗したら、パスワードの間違いとは言わず、通信エラーとして伝える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signInWithPassword.mockImplementation(async () => ({ data: { user: null, session: null }, error: networkDown }));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('通信に失敗しました');
    expect(text()).not.toContain('現在のパスワードが正しくありません');
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('再認証の呼び出しが例外を投げても (通信断など)、画面は壊れず、更新には進まない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signInWithPassword.mockRejectedValue(new TypeError('Failed to fetch'));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('通信に失敗しました');
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    // 送信ボタンは押せる状態に戻る
    expect((container.querySelector('[data-testid="password-change-form"] button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ================================================================
// 5. パスワード変更: 成功
// ================================================================
describe('#1187 パスワード変更: 成功', () => {
  it('再認証 → updateUser → signOut({ scope: "others" }) の順に呼ぶ', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(mocks.calls).toEqual(['getUser', 'signInWithPassword', 'updateUser', 'signOut:others']);

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: USER_EMAIL, password: CURRENT_PASSWORD });
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW_PASSWORD });
    // 'others': 今の端末のセッションは残して、ほかの端末のログインだけを解除する (global にすると、この端末も追い出される)
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('この端末はログインしたまま: ユーザー別データの削除も、他タブへのサインアウト通知も、画面遷移もしない', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('成功の表示で、ほかの端末のログインを解除したことを伝え、入力欄を空にする', async () => {
    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    const success = byTestId('password-change-success');
    expect(success?.textContent).toContain('パスワードを変更しました');
    expect(success?.textContent).toContain('この端末以外のログインはすべて解除しました');
    expect(success?.textContent).not.toContain('確認できませんでした');
    expect(success?.getAttribute('role')).toBe('status');

    // パスワードを画面に残さない
    expect(field('current-password').value).toBe('');
    expect(field('new-password').value).toBe('');
    expect(field('confirm-password').value).toBe('');
    // エラーは出ていない
    expect(container.querySelector('[role="alert"]')).toBeNull();
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

  it('二重に送信しても、再認証・更新は 1 回だけ。処理中はボタンを押せない', async () => {
    let release!: (value: unknown) => void;
    mocks.signInWithPassword.mockImplementation(() => {
      mocks.calls.push('signInWithPassword');
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    await renderPage();
    await type('current-password', CURRENT_PASSWORD);
    await type('new-password', NEW_PASSWORD);
    await type('confirm-password', NEW_PASSWORD);
    await submit('password-change-form'); // 1 回目: 再認証の応答待ち
    await submit('password-change-form'); // 2 回目: 待っている間

    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    const button = container.querySelector('[data-testid="password-change-form"] button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('変更中');

    await act(async () => {
      release({ data: { user: emailUser(), session: {} }, error: null });
    });

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
  });
});

// ================================================================
// 6. パスワード変更: 更新・ログアウトの失敗
// ================================================================
describe('#1187 パスワード変更: 更新やログアウトの失敗', () => {
  it('updateUser が失敗したら、その理由を日本語で出し、他の端末はログアウトしない', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUser.mockImplementation(async () => {
      mocks.calls.push('updateUser');
      return {
        data: { user: null },
        error: {
          name: 'AuthWeakPasswordError',
          status: 422,
          code: 'weak_password',
          message: 'Password should be at least 6 characters.',
          reasons: ['pwned'],
        },
      };
    });

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(mocks.calls).toEqual(['getUser', 'signInWithPassword', 'updateUser']);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(text()).toContain('過去に流出したことが確認されています');
    expect(text()).not.toContain('Password should be at least');
    expect(byTestId('password-change-success')).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it('GoTrue が今のパスワードと同じと判断した (same_password) ときも、日本語で伝える', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.updateUser.mockImplementation(async () => ({
      data: { user: null },
      error: { name: 'AuthApiError', status: 422, code: 'same_password', message: 'New password should be different from the old password.' },
    }));

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('現在のパスワードと違うものにしてください');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  const signOutFailures: Array<[string, () => Promise<{ error: { name: string; status: number; message: string } | null }>]> = [
    ['エラーを返す', async () => ({ error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } })],
    [
      '例外を投げる',
      async () => {
        throw new Error('network down');
      },
    ],
  ];

  it.each(signOutFailures)('signOut が%s: パスワードは変更済みなので成功を伝え、ほかの端末を確認できなかったことを添える', async (_label, impl) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signOut.mockImplementation(async (options?: { scope?: string }) => {
      mocks.calls.push(`signOut:${options?.scope}`);
      return impl();
    });

    await renderPage();
    await submitPasswordForm(CURRENT_PASSWORD, NEW_PASSWORD);

    const success = byTestId('password-change-success');
    expect(success?.textContent).toContain('パスワードを変更しました');
    expect(success?.textContent).toContain('他の端末のログアウトを確認できませんでした');
    expect(success?.textContent).not.toContain('すべて解除しました');
    // 「変更に失敗しました」とは言わない
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // 更新は 1 回だけ (再試行で同じパスワードを送り直さない)
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});

// ================================================================
// 6.5 どの失敗でも、入力したパスワードをログに出さない
// ================================================================
describe('#1187 パスワード変更: どの失敗でも、入力したパスワードをコンソールに出さない', () => {
  const failures: Array<[string, () => void]> = [
    [
      '再認証のエラー',
      () =>
        mocks.signInWithPassword.mockImplementation(async () => ({
          data: { user: null, session: null },
          error: invalidCredentials,
        })),
    ],
    ['再認証の例外', () => mocks.signInWithPassword.mockRejectedValue(new TypeError('Failed to fetch'))],
    [
      '更新のエラー',
      () =>
        mocks.updateUser.mockImplementation(async () => ({
          data: { user: null },
          error: { name: 'AuthApiError', status: 422, code: 'same_password', message: 'New password should be different from the old password.' },
        })),
    ],
    ['更新の例外', () => mocks.updateUser.mockRejectedValue(new TypeError('Failed to fetch'))],
    ['signOut のエラー', () => mocks.signOut.mockImplementation(async () => ({ error: networkDown }))],
    ['signOut の例外', () => mocks.signOut.mockRejectedValue(new Error('network down'))],
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
