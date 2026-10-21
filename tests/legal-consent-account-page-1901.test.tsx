/**
 * #1901 (設計書 cross/20 Q-23): 規約・プライバシーポリシーに同意していない人が、同意しないまま本人で退会とデータの書き出しをする画面
 * /legal-consent/account (src/app/legal-consent/account/page.tsx と AccountWithoutConsent.tsx)。
 *
 * 確かめること:
 *   - ページ (サーバー側): 未ログインはログインの画面へ (戻り先はこの画面)。ログイン中なら同意の状態に関わらず出す
 *   - 書き出し: GET /api/account/export を呼び、JSON をファイルとして保存する
 *   - 退会: 「削除します」と入力するまで押せない。POST /api/account/delete { confirm: true } のあと、端末のユーザー別データを消してから
 *     signOut し、ログインの画面へ移らずに「退会しました」を出す (アプリの WebView では同意画面の上に「閉じる」が出るため)
 *   - 組織のオーナー・家族の代表者 (409) は、サーバーの文と、解散すると退会できることの案内を出し、その場に解散の区画を出す。ログアウトしない
 *     (#1917 docs/design/family/11-self-dissolve.md §15.4。409 の本文に立場の id が無ければ、サポートへの案内だけ)
 *   - この画面が呼ぶ API は、同意の許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) にある退会・書き出しと、409 のときの家族グループ / 組織の解散の 4 本だけ
 *   - お問い合わせと、同意の画面へ戻るリンクがある
 *
 * このリポジトリには @testing-library/react が無いため、サーバー側は react-dom/server、画面は react-dom/client + act で描画する。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_CONSENT_COPY, isLegalConsentExemptApiPath } from '@homegohan/shared';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  redirect: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  // 本物の redirect() は例外を投げて描画を止める。同じ動きにして、呼ばれた先を記録する
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: mocks.signOut } }),
}));

const { default: LegalConsentAccountPage } = await import('@/app/legal-consent/account/page');
const { default: AccountWithoutConsent } = await import('@/app/legal-consent/account/AccountWithoutConsent');
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge';
import { BLOCKED_SCOPE_UNKNOWN_GUIDANCE, SELF_DISSOLVED_NEXT_STEP } from '@/lib/membership/self-dissolve';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 画面のパス (lib/legal-consent.ts の LEGAL_CONSENT_ACCOUNT_PATH と同じ値。値そのものを固定する) */
const ACCOUNT_PATH = '/legal-consent/account';
/** 退会の確認のために入力する言葉 (src/lib/account-self-service.ts の ACCOUNT_DELETE_CONFIRM_KEYWORD) */
const CONFIRM_KEYWORD = '削除します';
/** 端末のユーザー別データのキー (signOut の前に消えていることを見る) */
const USER_SCOPED_KEY = 'v4_range_days';
/** 書き出しの連打の上限 (429) の Retry-After の秒 (2 分) */
const RETRY_AFTER_SEC = '120';

let container: HTMLDivElement;
let root: Root;
let events: string[];
const fetchMock = vi.fn();
const downloads: string[] = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalClick = HTMLAnchorElement.prototype.click;

beforeEach(() => {
  resetNativeAuthBridgeForTests();
  events = [];
  downloads.length = 0;
  mocks.push.mockReset();
  mocks.redirect.mockReset();
  mocks.getUser.mockReset();
  mocks.signOut.mockReset();
  mocks.signOut.mockImplementation(async () => {
    events.push(`signOut:storage=${localStorage.getItem(USER_SCOPED_KEY) === null ? 'cleared' : 'kept'}`);
    return { error: null };
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
  localStorage.setItem(USER_SCOPED_KEY, '1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalClick;
});

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  expect(button, text).toBeDefined();
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

async function typeConfirm(value: string) {
  const input = container.querySelector<HTMLInputElement>('#legal-consent-account-delete-confirm');
  expect(input).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 解散の区画の入力欄 (data-testid は SelfDissolveSection の self-dissolve-<scope>-keyword) に入力する */
async function typeDissolveKeyword(scope: 'family' | 'organization', value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="self-dissolve-${scope}-keyword"]`);
  expect(input, `self-dissolve-${scope}-keyword`).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function dissolveSubmit(scope: 'family' | 'organization'): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="self-dissolve-${scope}-submit"]`);
}

const FAMILY_REPRESENTATIVE_MESSAGE = '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';

/** 1 回目の退会は 409 (家族の代表者・本文に family_group)、解散は 200、2 回目の退会は 200 を返す fetch */
function blockedThenDissolvedFetch() {
  let deleteCalls = 0;
  return async (input: string) => {
    if (input === '/api/account/delete') {
      deleteCalls += 1;
      return deleteCalls === 1
        ? new Response(
            JSON.stringify({
              error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
              message: FAMILY_REPRESENTATIVE_MESSAGE,
              family_group: { id: FAMILY_ID, name: '山田家' },
            }),
            { status: 409 },
          )
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (input === '/api/family/dissolve') {
      return new Response(JSON.stringify({ data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('#1901 Q-23 同意の前の退会と書き出しの画面 (/legal-consent/account): ページ', () => {
  it('未ログインは、ログインの画面へ回す (ログインの後はこの画面へ戻る)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    await expect(LegalConsentAccountPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(ACCOUNT_PATH)}`);
  });

  it('ログイン中なら、見出し・導入と、書き出しと退会の枠を出す (同意の状態を問わない)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

    const html = renderToStaticMarkup(await LegalConsentAccountPage());

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain(LEGAL_CONSENT_COPY.accountPageHeading);
    expect(html).toContain(LEGAL_CONSENT_COPY.accountPageIntro);
    expect(html).toContain('データをエクスポート');
    expect(html).toContain('アカウントを削除');
  });
});

describe('#1901 Q-23 同意の前の退会と書き出しの画面 (/legal-consent/account): 操作', () => {
  it('書き出し: GET /api/account/export を呼び、JSON をファイルとして保存する', async () => {
    fetchMock.mockResolvedValue(new Response('{"user_id":"u1"}', { status: 200 }));
    await render(<AccountWithoutConsent />);

    await click(buttonByText('データをエクスポート'));

    expect(fetchMock).toHaveBeenCalledWith('/api/account/export', { method: 'GET' });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^homegohan-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(container.textContent).toContain('データを書き出しました。');
  });

  it('書き出し: 連打の上限 (429) は、待つ時間を画面に出す', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': RETRY_AFTER_SEC } }));
    await render(<AccountWithoutConsent />);

    await click(buttonByText('データをエクスポート'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('2分ほど待ってから');
    expect(downloads).toHaveLength(0);
  });

  it('退会: 「削除します」と入力するまで押せない', async () => {
    await render(<AccountWithoutConsent />);

    expect(buttonByText('アカウントを削除').disabled).toBe(true);
    await typeConfirm('削除');
    expect(buttonByText('アカウントを削除').disabled).toBe(true);
    await typeConfirm(CONFIRM_KEYWORD);
    expect(buttonByText('アカウントを削除').disabled).toBe(false);
  });

  it('退会: POST /api/account/delete { confirm: true } のあと、端末のユーザー別データを消してから signOut し、ログインの画面へ移らずに「退会しました」を出す', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await render(<AccountWithoutConsent />);

    await typeConfirm(CONFIRM_KEYWORD);
    await click(buttonByText('アカウントを削除'));

    expect(fetchMock).toHaveBeenCalledWith('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(events).toEqual(['signOut:storage=cleared']);
    expect(mocks.push).not.toHaveBeenCalled();
    const deleted = container.querySelector('[data-testid="legal-consent-account-deleted"]');
    expect(deleted?.textContent).toContain(LEGAL_CONSENT_COPY.accountDeletedHeading);
    expect(deleted?.textContent).toContain(LEGAL_CONSENT_COPY.accountDeletedBody);
    expect(container.querySelector('button')).toBeNull();
  });

  it('退会: 409 の本文に立場の id が無ければ、サーバーの文と BLOCKED_SCOPE_UNKNOWN_GUIDANCE を出し、解散の区画は出さない。ログアウトしない', async () => {
    const serverMessage = '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', message: serverMessage }), { status: 409 }),
    );
    await render(<AccountWithoutConsent />);

    await typeConfirm(CONFIRM_KEYWORD);
    await click(buttonByText('アカウントを削除'));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`${serverMessage} ${BLOCKED_SCOPE_UNKNOWN_GUIDANCE}`);
    expect(dissolveSubmit('family')).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="legal-consent-account-deleted"]')).toBeNull();
    expect(buttonByText('アカウントを削除').disabled).toBe(false);
  });

  it('退会: 家族の代表者 (409。本文に family_group の id と名前) は、サーバーの文と LEGAL_CONSENT_COPY.accountDeleteBlockedGuidance (解散すると退会できる) を出し、家族名つきの解散の区画を出す。ログアウトしない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
          message: FAMILY_REPRESENTATIVE_MESSAGE,
          family_group: { id: FAMILY_ID, name: '山田家' },
        }),
        { status: 409 },
      ),
    );
    await render(<AccountWithoutConsent />);

    await typeConfirm(CONFIRM_KEYWORD);
    await click(buttonByText('アカウントを削除'));

    expect(container.textContent).toContain(`${FAMILY_REPRESENTATIVE_MESSAGE} ${LEGAL_CONSENT_COPY.accountDeleteBlockedGuidance}`);
    expect(LEGAL_CONSENT_COPY.accountDeleteBlockedGuidance).toContain('解散すると、退会できます');
    expect(container.textContent).toContain('「山田家」を解散する');
    expect(dissolveSubmit('family')).not.toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="legal-consent-account-deleted"]')).toBeNull();
  });

  it('解散の区画で解散すると (POST /api/family/dissolve が 200)、区画が消えて SELF_DISSOLVED_NEXT_STEP が出る。そのあとの退会は 200 で「退会しました」を出す', async () => {
    fetchMock.mockImplementation(blockedThenDissolvedFetch());
    await render(<AccountWithoutConsent />);

    await typeConfirm(CONFIRM_KEYWORD);
    await click(buttonByText('アカウントを削除'));
    await typeDissolveKeyword('family', '解散します');
    await click(dissolveSubmit('family')!);

    expect(dissolveSubmit('family')).toBeNull();
    expect(container.textContent).toContain(SELF_DISSOLVED_NEXT_STEP);

    await click(buttonByText('アカウントを削除'));
    expect(events).toEqual(['signOut:storage=cleared']);
    const deleted = container.querySelector('[data-testid="legal-consent-account-deleted"]');
    expect(deleted?.textContent).toContain(LEGAL_CONSENT_COPY.accountDeletedHeading);
  });

  it('セッションが切れていた (401) ら、ログインの画面へ移る (ログインの後はこの画面へ戻る)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await render(<AccountWithoutConsent />);

    await click(buttonByText('データをエクスポート'));

    expect(mocks.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(ACCOUNT_PATH)}`);
  });

  it('この画面が呼ぶ API は、同意の許可リストにある退会・書き出しと、409 のときの家族グループ / 組織の解散の 4 本だけ', async () => {
    fetchMock.mockImplementation(blockedThenDissolvedFetch());
    await render(<AccountWithoutConsent />);

    await click(buttonByText('データをエクスポート'));
    await typeConfirm(CONFIRM_KEYWORD);
    await click(buttonByText('アカウントを削除'));
    await typeDissolveKeyword('family', '解散します');
    await click(dissolveSubmit('family')!);
    await click(buttonByText('アカウントを削除'));

    expect([...new Set(calledPaths())].sort()).toEqual(['/api/account/delete', '/api/account/export', '/api/family/dissolve']);
    for (const path of calledPaths()) {
      expect(isLegalConsentExemptApiPath(path), path).toBe(true);
    }
  });

  it('お問い合わせと、同意の画面へ戻るリンクがある', async () => {
    await render(<AccountWithoutConsent />);

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/contact', '/legal-consent']));
  });
});
