/**
 * #1188: パスワード再設定の完了時に、この端末を含む全端末のログインを無効にする (Web)
 *
 * 修正前:
 *   - /auth/reset-password は updateUser({ password }) が成功しても signOut を呼ばず、3 秒後に /login へ
 *     push するだけだった。リセットメールのリンクで作られたセッションが、この端末に生きたまま残る
 *     (設計書 docs/design/cross/01-auth-session.md §9.1 の「全セッション revoke (リセット後は再ログイン強制)」を
 *     満たさない。モバイルは signOut() を呼んでいて、既定の scope が global なので全端末が失効する)。
 * 修正後:
 *   - 更新に成功したら、端末のユーザー別データを消し (CLAUDE.md: signOut より前)、
 *     signOut({ scope: 'global' }) で全セッションを失効させ、他タブへ SIGNED_OUT を知らせてから成功画面を出す。
 * #1720 段 C: 更新は supabase.auth.updateUser ではなく POST /api/auth/password/reset (履歴の照合と再設定の認可はサーバー。
 *   docs/design/cross/16-auth-history-sessions.md §14.7)。成功の後の流れ (clear → signOut global → broadcast → 3 秒後に /login) は変わらない。
 *
 * #1165: ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 *   外すロックが無いので、再設定の画面はロックを外す API (以前の POST /api/auth/login-lock/clear) を呼ばない。
 *   fetch を見張り、パスワードの再設定の API のほかは呼ばないことを確かめる。
 *
 * カバレッジ:
 *   1. 成功: POST /api/auth/password/reset → clearUserScopedLocalStorage → signOut({ scope: 'global' }) → broadcastSignOut の順。
 *      成功画面を出し、3 秒後に /login へ。signOut の後でないと /login へ行かない
 *   2. 再設定 API の失敗 (422 など): signOut もストレージ削除もしない (更新できていないのでログインは維持する)
 *   3. signOut の失敗 (エラーを返す / 例外): パスワードは更新済みなので成功画面は出すが、注意書きを出す。
 *      サインアウトできていないので他タブには SIGNED_OUT を知らせない
 *   4. 入力の検証エラー: どの API も呼ばない
 *
 * @testing-library/react は未インストールのため、他のコンポーネントテストと同じく
 * react-dom/client + act で実際にレンダリングする。
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  /** 呼び出し順の記録 */
  calls: [] as string[],
  getSession: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  push: vi.fn(),
  clearUserScopedLocalStorage: vi.fn(),
  broadcastSignOut: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mocks.getSession,
      updateUser: mocks.updateUser,
      signOut: mocks.signOut,
    },
  }),
}));

vi.mock('@/lib/user-storage', () => ({
  clearUserScopedLocalStorage: mocks.clearUserScopedLocalStorage,
  broadcastSignOut: mocks.broadcastSignOut,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

// framer-motion はアニメーション完了待ち (AnimatePresence の exit) が jsdom で不安定なので素通しにする。
// motion.div などは毎回同じコンポーネントを返す (違う型になると再描画のたびに作り直されてしまう)。
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    function Passthrough({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) {
      return react.createElement(tag, rest, children);
    };
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => (cache[tag] ??= passthrough(tag)),
      },
    ),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

import ResetPasswordPage from '@/app/(auth)/auth/reset-password/page';

// ── 描画と操作のヘルパー ───────────────────────────────────────────────────────
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEW_PASSWORD = 'NewPass2026x';
const RESET_CALL = 'fetch:POST /api/auth/password/reset';
const apiError = (status: number, code: string, error: string) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { 'Content-Type': 'application/json' } });

let container: HTMLDivElement;
let root: Root;

async function renderPage() {
  await React.act(async () => {
    root.render(React.createElement(ResetPasswordPage));
  });
  // getSession の結果を待って、フォームが出るまで進める
  await React.act(async () => {});
}

function setInputValue(input: HTMLInputElement, value: string) {
  // React の制御コンポーネントは value のセッター経由だと変更を拾えないので、プロトタイプのセッターを使う
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function fillAndSubmit(password: string, confirm: string) {
  const inputs = container.querySelectorAll('input');
  expect(inputs).toHaveLength(2);
  await React.act(async () => {
    setInputValue(inputs[0] as HTMLInputElement, password);
    setInputValue(inputs[1] as HTMLInputElement, confirm);
  });
  const form = container.querySelector('form')!;
  await React.act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const text = () => container.textContent ?? '';

beforeEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();

  // リセットメールのリンクから来て、セッションがある状態
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'recovery-token' } } });
  mocks.updateUser.mockImplementation(async () => {
    mocks.calls.push('updateUser');
    return { data: {}, error: null };
  });
  mocks.signOut.mockImplementation(async (options?: { scope?: string }) => {
    mocks.calls.push(`signOut:${options?.scope}`);
    return { error: null };
  });
  mocks.clearUserScopedLocalStorage.mockImplementation(() => {
    mocks.calls.push('clearUserScopedLocalStorage');
  });
  mocks.broadcastSignOut.mockImplementation(() => {
    mocks.calls.push('broadcastSignOut');
  });
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    mocks.calls.push(`fetch:${String(init?.method)} ${url}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', mocks.fetch);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await React.act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ================================================================
// 1. 成功
// ================================================================
describe('#1188 パスワード再設定の成功時', () => {
  it('更新後に、ストレージ削除 → signOut({ scope: "global" }) → 他タブへ通知 の順で全端末をログアウトする', async () => {
    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    // 更新は再設定の API (#1720 段 C)。supabase.auth.updateUser は呼ばない
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/auth/password/reset');
    expect(JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ new_password: NEW_PASSWORD });

    // global: この端末 (リセットリンクで作られたセッション) と他端末のセッションをすべて失効させる。
    // 'others' では今のセッションが残ってしまうので、ここでは使わない
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'global' });

    // CLAUDE.md: signOut より前にストレージを消す。他タブへの通知は signOut の後
    // #1165: ロックは無いので、ロックを外す API は呼ばない (fetch の呼び出しが calls に入らない)
    expect(mocks.calls).toEqual([
      RESET_CALL,
      'clearUserScopedLocalStorage',
      'signOut:global',
      'broadcastSignOut',
    ]);
  });

  it('#1165 ロックが無いので、再設定を済ませてもロックを外す API (/api/auth/login-lock/clear) を呼ばない (呼ぶ API は再設定の 1 本だけ)', async () => {
    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);
    expect(text()).toContain('パスワードを更新しました');
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(mocks.fetch.mock.calls.map((call) => call[0])).toEqual(['/api/auth/password/reset']);
  });

  it('成功画面に、全端末からログアウトしたことと新しいパスワードで入り直すことを出す (注意書きは出さない)', async () => {
    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('パスワードを更新しました');
    expect(text()).toContain('すべての端末からログアウトしました');
    expect(text()).toContain('新しいパスワードでログイン');
    expect(text()).not.toContain('確認できませんでした');
    // フォームは消えている
    expect(container.querySelector('form')).toBeNull();
  });

  it('3 秒後に /login へ移動する (それまでは移動しない)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();

    await React.act(async () => {
      vi.advanceTimersByTime(2999);
    });
    expect(mocks.push).not.toHaveBeenCalled();

    await React.act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/login');
  });
});

// ================================================================
// 2. updateUser の失敗
// ================================================================
describe('#1188 パスワードを更新できなかったとき', () => {
  it('422 VALID_PASSWORD_HISTORY: signOut もストレージ削除もせず、本文の文言を出してフォームに残る (ログインは維持)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      mocks.calls.push(`fetch:${String(init?.method)} ${url}`);
      return apiError(422, 'VALID_PASSWORD_HISTORY', '最近使ったパスワードは使えません。別のパスワードにしてください。');
    });

    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
    // 呼んだのは再設定の API だけ (#1165: ロックを外す API は無い)
    expect(mocks.calls).toEqual([RESET_CALL]);

    expect(text()).toContain('最近使ったパスワードは使えません');
    expect(text()).not.toContain('パスワードを更新しました');
    expect(container.querySelector('form')).not.toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('403 AUTH_RECOVERY_SESSION_REQUIRED: 「リンクが無効です」の画面と同じ案内を出す (signOut しない)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () =>
      apiError(403, 'AUTH_RECOVERY_SESSION_REQUIRED', 'パスワードの再設定は、再設定メールのリンクから開き直してください。'),
    );

    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('リンクが無効です');
    expect(container.querySelector('a[href="/auth/forgot-password"]')).not.toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('通信の失敗 (fetch の reject): 通信エラーの文言を出し、signOut しない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    expect(text()).toContain('通信に失敗しました');
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(container.querySelector('form')).not.toBeNull();
  });
});

// ================================================================
// 3. signOut の失敗 (パスワードは更新済み)
// ================================================================
describe('#1188 パスワードは更新できたが、全端末のログアウトに失敗したとき', () => {
  const failures: Array<[string, () => Promise<{ error: { message: string } | null }>]> = [
    ['エラーを返す', async () => ({ error: { message: 'fetch failed' } })],
    [
      '例外を投げる',
      async () => {
        throw new Error('network down');
      },
    ],
  ];

  it.each(failures)('signOut が%s: エラー画面に戻さず成功画面を出し、確認できなかったことを知らせる', async (_label, impl) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signOut.mockImplementation(async (options?: { scope?: string }) => {
      mocks.calls.push(`signOut:${options?.scope}`);
      return impl();
    });

    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);

    // 更新は済んでいる。「パスワードの更新に失敗しました」には戻さない
    expect(text()).toContain('パスワードを更新しました');
    expect(text()).not.toContain('パスワードの更新に失敗しました');
    expect(text()).toContain('確認できませんでした');
    // 実際にログアウトできていないので、「すべての端末からログアウトしました」とは言わない
    expect(text()).not.toContain('すべての端末からログアウトしました');

    // 更新は 1 回だけ (再試行で同じパスワードを送り直さない)
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // サインアウトできていないので、他タブを /login へ飛ばさない
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual([RESET_CALL, 'clearUserScopedLocalStorage', 'signOut:global']);
    expect(consoleError).toHaveBeenCalled();
  });

  it('失敗しても 3 秒後に /login へ移動する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.signOut.mockResolvedValue({ error: { message: 'fetch failed' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, NEW_PASSWORD);
    await React.act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.push).toHaveBeenCalledWith('/login');
  });
});

// ================================================================
// 4. 入力の検証エラー
// ================================================================
describe('#1188 入力の検証エラー', () => {
  it('パスワードが一致しなければ、どの API も呼ばない', async () => {
    await renderPage();
    await fillAndSubmit(NEW_PASSWORD, `${NEW_PASSWORD}-different`);

    expect(text()).toContain('パスワードが一致しません');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearUserScopedLocalStorage).not.toHaveBeenCalled();
    expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
  });

  it('弱いパスワード (数字だけ) なら、どの API も呼ばない', async () => {
    await renderPage();
    await fillAndSubmit('12345678', '12345678');

    expect(text()).toContain('英字');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
