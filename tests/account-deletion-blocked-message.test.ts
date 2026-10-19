// #1447 (5) 退会できない (409: 組織のオーナー・家族グループの代表者) ときの案内
//
// Web の設定画面 (src/app/(main)/settings/page.tsx) は、409 でも固定の「削除に失敗しました」としか出さず、
// deleteOwnAccount (src/lib/account-self-service.ts) が返す、譲渡や解散が先だというサーバーの文を捨てていた。
//   1. 409 のときは、サーバーの文 (src/lib/account-deletion.ts の findBlocker が書く固定の文) を出す
//   2. 409 で本文に文が無ければ、定型の文 (ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE) を出す
//   3. それ以外の失敗 (500・通信の失敗) は汎用の文 (ACCOUNT_DELETE_FAILED_MESSAGE)。生のエラー文は出さない
//   4. 401 は失敗の文を出さず、ログインの画面へ
//   6. (#1562 → #1917) 409 の本文の error から立場 (組織のオーナー / 家族の代表者) が分かれば、理由の文に続けてメンバーシップ設定 (譲渡か解散) を
//      開くかを尋ね (confirm)、開くならその画面へ移る。立場が分からなければ、これまでどおり理由の文だけ (alert)
//   7. (#1917) deleteOwnAccount は 409 の本文の family_group / organization の id と名前を scope として持ち帰る (読めなければ null)
//   5. アプリ (apps/mobile/src/lib/account-deletion-error.ts) の文面は Web と同じ値
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (ai-consent-settings-entry.test.ts と同じ)。

import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE,
  ACCOUNT_DELETE_BLOCKED_GUIDE,
  ACCOUNT_DELETE_CONFIRM_KEYWORD,
  ACCOUNT_DELETE_FAILED_MESSAGE,
  accountDeletionBlockedMessage,
  deleteOwnAccount,
} from '@/lib/account-self-service';
import { ACCOUNT_DELETE_API_PATH } from '@/lib/auth/frozen';
import * as mobileMessages from '../apps/mobile/src/lib/account-deletion-error';

const h = React.createElement;

/** サーバー (src/lib/account-deletion.ts の findBlocker) が 409 の本文に入れる文 */
const ORG_OWNER_MESSAGE = '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。';
const FAMILY_REPRESENTATIVE_MESSAGE = '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(async () => ({})),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      signOut: mocks.signOut,
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  }),
}));
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, className, onClick, role }: Record<string, unknown>) =>
          react.createElement(tag, { className, onClick, role }, children as React.ReactNode),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

import SettingsPage from '@/app/(main)/settings/page';

/** 退会の API が返す応答 (それ以外の API = 起動時の通知設定の取得などは失敗扱い。この画面の関心事ではない) */
let deleteResponse: () => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Web の設定 (/settings): 退会に失敗したときの文 (#1447)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let alertSpy: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === ACCOUNT_DELETE_API_PATH) return deleteResponse();
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
    act(() => {
      root.render(h(SettingsPage));
    });
    await act(async () => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /** 削除の確認の画面を開き、確認の言葉を入れて「アカウントを完全に削除する」を押す */
  async function submitDeletion() {
    const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="アカウントを削除する"]');
    expect(openButton).not.toBeNull();
    act(() => {
      openButton!.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="削除確認テキスト入力"]');
    expect(input).not.toBeNull();
    act(() => {
      setInputValue(input!, ACCOUNT_DELETE_CONFIRM_KEYWORD);
    });
    const submit = container.querySelector<HTMLButtonElement>('button[aria-label="アカウントを完全に削除する"]');
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit!.click();
    });
    await act(async () => {});
    expect(fetchSpy).toHaveBeenCalledWith(ACCOUNT_DELETE_API_PATH, expect.objectContaining({ method: 'POST' }));
    return submit!;
  }

  it.each([
    ['組織のオーナー', 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', ORG_OWNER_MESSAGE, 'organization'],
    ['家族グループの代表者', 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', FAMILY_REPRESENTATIVE_MESSAGE, 'family_group'],
  ] as const)(
    '409 (%s): 失敗の定型文ではなく、譲渡や解散が先だというサーバーの文を出し、メンバーシップ設定 (譲渡か解散) を開くかを尋ねる (開かなければ留まる)',
    async (_label, code, message, blocker) => {
      deleteResponse = async () => jsonResponse(409, { error: code, message, organization: { id: 'org-1', name: '組織 A' } });
      const submit = await submitDeletion();

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith(`${message}\n\n${ACCOUNT_DELETE_BLOCKED_GUIDE[blocker].prompt}`);
      expect(alertSpy).not.toHaveBeenCalled();
      // 退会はしていない: ログアウトもログインの画面への移動もしない。開かないと答えたので、もう一度押せる状態に戻る
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.push).not.toHaveBeenCalled();
      expect(submit.disabled).toBe(false);
    },
  );

  it.each([
    ['ACCOUNT_DELETE_BLOCKED_ORG_OWNER', '/settings/membership'],
    ['ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', '/settings/membership'],
  ])('409 (%s) で開くと答えたら、メンバーシップ設定 (%s) へ移る。ログアウトはしない', async (code, path) => {
    confirmSpy.mockReturnValue(true);
    deleteResponse = async () => jsonResponse(409, { error: code, message: ORG_OWNER_MESSAGE });
    await submitDeletion();

    expect(mocks.push).toHaveBeenCalledWith(path);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('409 で本文に文が無いときは、定型の案内の文を出す (立場が分かればメンバーシップ設定を開くかも尋ねる)', async () => {
    deleteResponse = async () => jsonResponse(409, { error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    await submitDeletion();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain(ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE);
  });

  it.each([
    ['本文の error が無い', { message: ORG_OWNER_MESSAGE }, ORG_OWNER_MESSAGE],
    ['本文の error が知らない値', { error: 'SOMETHING_ELSE' }, ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE],
  ])('409 で立場が分からない (%s) ときは、理由の文だけを出す (メンバーシップ設定へは案内しない)', async (_label, body, expected) => {
    deleteResponse = async () => jsonResponse(409, body);
    await submitDeletion();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(expected);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('500 は汎用の文を出す (サーバーの本文の文字列は出さない)', async () => {
    deleteResponse = async () => jsonResponse(500, { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    const submit = await submitDeletion();

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(ACCOUNT_DELETE_FAILED_MESSAGE);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(submit.disabled).toBe(false);
  });

  it('通信の失敗は汎用の文を出す', async () => {
    deleteResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    await submitDeletion();

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(ACCOUNT_DELETE_FAILED_MESSAGE);
  });

  it('401 は失敗の文を出さず、ログインの画面へ移る', async () => {
    deleteResponse = async () => jsonResponse(401, { error: 'Unauthorized' });
    await submitDeletion();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith('/login');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('成功したときは文を出さず、ログアウトしてログインの画面へ移る', async () => {
    deleteResponse = async () => jsonResponse(200, { success: true });
    await submitDeletion();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/login');
  });
});

describe('サーバーが 409 の本文に入れる文', () => {
  it('このテストの 2 つの文は、src/lib/account-deletion.ts の findBlocker が書く文と同じ (利用者向けの固定の文)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/account-deletion.ts'), 'utf8');
    expect(source).toContain(`message: '${ORG_OWNER_MESSAGE}'`);
    expect(source).toContain(`message: '${FAMILY_REPRESENTATIVE_MESSAGE}'`);
  });
});

describe('accountDeletionBlockedMessage', () => {
  it('サーバーの文があればそれを、無い・空ならば定型の文を返す', () => {
    expect(accountDeletionBlockedMessage(ORG_OWNER_MESSAGE)).toBe(ORG_OWNER_MESSAGE);
    expect(accountDeletionBlockedMessage(null)).toBe(ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE);
    expect(accountDeletionBlockedMessage('  ')).toBe(ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE);
  });
});

describe('アプリの退会の失敗の文は、Web と同じ値', () => {
  it('汎用の文・409 の定型の文', () => {
    expect(mobileMessages.ACCOUNT_DELETE_FAILED_MESSAGE).toBe(ACCOUNT_DELETE_FAILED_MESSAGE);
    expect(mobileMessages.ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE).toBe(ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE);
  });
});

describe('deleteOwnAccount: 409 の本文の立場の id と名前 (scope。#1917)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 退会の API への fetch を、決まった応答で置き換える */
  function stubDeleteResponse(response: Response) {
    vi.stubGlobal('fetch', vi.fn(async () => response));
  }

  it.each([
    [
      '組織のオーナー',
      { error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', message: ORG_OWNER_MESSAGE, organization: { id: 'org-1', name: '組織 A' } },
      ORG_OWNER_MESSAGE,
      'organization',
      { id: 'org-1', name: '組織 A' },
    ],
    [
      '家族グループの代表者',
      { error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', message: FAMILY_REPRESENTATIVE_MESSAGE, family_group: { id: 'fg-1', name: '家族 A' } },
      FAMILY_REPRESENTATIVE_MESSAGE,
      'family_group',
      { id: 'fg-1', name: '家族 A' },
    ],
  ] as const)('deleteOwnAccount は 409 の本文の family_group / organization の id と名前を scope として持ち帰る (%s)', async (_label, body, message, blocker, scope) => {
    stubDeleteResponse(jsonResponse(409, body));
    await expect(deleteOwnAccount()).resolves.toEqual({ kind: 'blocked', message, blocker, scope });
  });

  it.each([
    [
      '立場に合う鍵が無い (代表者なのに organization だけ)',
      jsonResponse(409, { error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', organization: { id: 'org-1', name: '組織 A' } }),
      'family_group',
    ],
    ['id が文字列でない', jsonResponse(409, { error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', organization: { id: 1, name: '組織 A' } }), 'organization'],
    ['名前が無い', jsonResponse(409, { error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', organization: { id: 'org-1' } }), 'organization'],
    ['立場が分からない (error が知らない値)', jsonResponse(409, { error: 'SOMETHING_ELSE', organization: { id: 'org-1', name: '組織 A' } }), null],
    ['本文が JSON でない', new Response('not json', { status: 409 }), null],
  ] as const)('deleteOwnAccount は 409 の本文から立場の id と名前が読めなければ scope を null にする (%s)', async (_label, response, blocker) => {
    stubDeleteResponse(response);
    const result = await deleteOwnAccount();
    expect(result).toMatchObject({ kind: 'blocked', blocker });
    expect(result.kind === 'blocked' ? result.scope : 'not-blocked').toBeNull();
  });
});
