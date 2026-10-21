/**
 * #1174 同意画面 /legal-consent (src/app/legal-consent/page.tsx と LegalConsentForm.tsx)
 *
 * 確認すること:
 *   - ページ (サーバー側): 未ログインはログイン画面へ、同意済みは戻り先へ回す。未同意なら同意フォームを出す。
 *     戻り先 (next) は同一オリジンの相対パスだけ。再同意 (すでに古い版に同意していた人) は「改定あり」の表示になる
 *   - フォーム: 必須のチェックボックスが 2 つ (利用規約・プライバシーポリシー)。両方チェックするまで「同意して続ける」は押せない。
 *     押すと POST /api/legal/accept に、いま有効な版を送る。成功したら戻り先へ (読み込み直し)。
 *     401 はログイン画面へ、409 (規約が更新された) は読み込み直しを案内、それ以外は汎用のエラー。いずれもやり直せる
 *   - 「同意しない」: localStorage を消し、ネイティブ (アプリの WebView) へ知らせてから signOut し (#1038)、
 *     ご利用いただけないことと、もう一度ログインすれば同意しなくても退会と書き出しができること (#1901 cross/20 Q-23) を案内する。
 *     API は呼ばない。signOut に失敗したら案内に進まず、エラーを出す
 *
 * #1173 (設計書 cross/14 T-F1〜T-F7): 生年月日の欄 (needsBirthDate)・18 歳未満の自己登録の案内 (minor_refused)・
 *   保護者の同意とのつながりが無い 18 歳未満の案内 (guardianMissing)・「登録をやめる」(退会) の流れ
 *
 * このリポジトリには @testing-library/react が無いため、サーバー側は react-dom/server、フォームは react-dom/client + act で描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGAL_CONSENT_BIRTH_DATE_COPY,
  LEGAL_CONSENT_COPY,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_PATHS,
  LEGAL_DOCUMENT_TYPES,
  formatLegalEffectiveDate,
  STORE_SUBSCRIPTION_DELETION_NOTICE,
} from '@homegohan/shared';

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

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  signOut: vi.fn(),
  clearUserScopedLocalStorage: vi.fn(),
  notifyNativeSignOut: vi.fn(),
  notifyNativeLegalConsentAccepted: vi.fn(),
  broadcastSignOut: vi.fn(),
  rpc: vi.fn(),
  deleteOwnAccount: vi.fn(),
  signOutAfterAccountDeletion: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock('next/navigation', () => ({
  // 本物の redirect() は例外を投げて描画を止める。同じ動きにして、呼ばれた先を記録する
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
    rpc: mocks.rpc,
  }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: mocks.signOut } }),
}));

vi.mock('@/lib/user-storage', () => ({
  clearUserScopedLocalStorage: () => {
    mocks.callOrder.push('clearUserScopedLocalStorage');
    mocks.clearUserScopedLocalStorage();
  },
  broadcastSignOut: () => {
    mocks.callOrder.push('broadcastSignOut');
    mocks.broadcastSignOut();
  },
}));

// #1038: WebView ならネイティブへも signOut の前に知らせる (アプリの中で「同意しない」を押したとき、アプリ側のログインも外す)
vi.mock('@/lib/native-auth-bridge', () => ({
  notifyNativeSignOut: () => {
    mocks.callOrder.push('notifyNativeSignOut');
    mocks.notifyNativeSignOut();
    return true;
  },
  // #1442: 同意を記録できたら、アプリ (WebView) の同意画面の route を閉じてもらう合図
  notifyNativeLegalConsentAccepted: () => {
    mocks.callOrder.push('notifyNativeLegalConsentAccepted');
    mocks.notifyNativeLegalConsentAccepted();
    return true;
  },
}));

// #1173: 「登録をやめる」の退会の呼び出し (文の定数と関数はそのまま、通信する 2 つだけ差し替える)
vi.mock('@/lib/account-self-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-self-service')>();
  return {
    ...actual,
    deleteOwnAccount: () => {
      mocks.callOrder.push('deleteOwnAccount');
      return mocks.deleteOwnAccount();
    },
    signOutAfterAccountDeletion: (client: unknown) => {
      mocks.callOrder.push('signOutAfterAccountDeletion');
      return mocks.signOutAfterAccountDeletion(client);
    },
  };
});

const { ACCOUNT_DELETE_FAILED_MESSAGE, accountDeletionBlockedMessage } = await import('@/lib/account-self-service');
const { default: LegalConsentPage } = await import('@/app/legal-consent/page');
const { default: LegalConsentForm } = await import('@/app/legal-consent/LegalConsentForm');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const ALL_OUTDATED = ['terms_of_service', 'privacy_policy'] as const;
/** 成人の placeholder。#1173 で生年月日が無いと同意画面を出すため */
const ADULT_BIRTH_DATE = '1990-01-01';
/** #1173 の 17 歳の it で固定する時刻 (JST 2026-10-16 12:00) と、その日に 17 歳の生年月日 */
const FIXED_NOW = new Date('2026-10-16T03:00:00.000Z');
const BIRTH_DATE_17 = '2008-10-17';

function profileRow(data: Record<string, unknown> | null) {
  mocks.maybeSingle.mockResolvedValue({ data, error: null });
}

async function renderPage(searchParams?: { next?: string | string[] }) {
  const element = await LegalConsentPage({ searchParams });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callOrder.length = 0;
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  profileRow(null);
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.deleteOwnAccount.mockResolvedValue({ kind: 'deleted' });
  mocks.signOutAfterAccountDeletion.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/legal-consent ページ (サーバー側)', () => {
  it('未ログインなら、ログイン画面へ回す (戻り先は、この同意画面)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(renderPage({ next: '/menus/weekly' })).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/legal-consent?next=${encodeURIComponent('/menus/weekly')}`)}`,
    );
  });

  it('★現行の版に同意済みの人は、同意画面を見せず、戻り先へ回す', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: ADULT_BIRTH_DATE });

    await expect(renderPage({ next: '/menus/weekly?date=2026-10-08' })).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledWith('/menus/weekly?date=2026-10-08');
  });

  it('戻り先が無い・安全でないときは /home', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: ADULT_BIRTH_DATE });

    for (const next of [undefined, '', 'https://evil.example/', '//evil.example/', '/legal-consent', '/api/account/export']) {
      mocks.redirect.mockClear();
      await expect(renderPage({ next })).rejects.toThrow('NEXT_REDIRECT');
      expect(mocks.redirect).toHaveBeenCalledWith('/home');
    }
  });

  it('next が複数あっても、先頭だけを使う', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: ADULT_BIRTH_DATE });

    await expect(renderPage({ next: ['/pantry', '/profile'] })).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledWith('/pantry');
  });

  it('未同意 (プロフィールの行が無い新規登録者) なら、初回の同意として、2 つの文書の版と施行日つきでフォームを出す', async () => {
    profileRow(null);

    const html = await renderPage();

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain('ほめゴハンをご利用いただくには');
    expect(html).not.toContain('改定されました');
    expect(html).not.toContain('改定あり');
    for (const type of LEGAL_DOCUMENT_TYPES) {
      const { version, effectiveDate } = LEGAL_DOCUMENTS[type];
      expect(html).toContain(LEGAL_DOCUMENT_LABELS[type]);
      expect(html).toContain(version);
      expect(html).toContain(formatLegalEffectiveDate(effectiveDate));
      expect(html).toContain(`href="${LEGAL_DOCUMENT_PATHS[type]}"`);
    }
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it('古い版に同意していた人 (再同意) には、改定された文書に「改定あり」を付ける', async () => {
    profileRow({ terms_version_accepted: 'v0-old', privacy_version_accepted: CURRENT_PRIVACY });

    const html = await renderPage();

    expect(html).toContain('改定されました');
    // 「改定あり」は、古い版の文書 (利用規約) の 1 か所だけ
    expect(html.match(/改定あり/g)).toHaveLength(1);
    const termsCard = html.slice(html.indexOf('data-testid="legal-doc-terms_of_service"'), html.indexOf('data-testid="legal-doc-privacy_policy"'));
    expect(termsCard).toContain('改定あり');
  });

  it('同意画面は検索エンジンに載せない (noindex)', async () => {
    const { metadata } = await import('@/app/legal-consent/page');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('/legal-consent フォーム (クライアント側)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let locationMock: { assign: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };

  function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ accepted: true }));
    vi.stubGlobal('fetch', fetchMock);
    locationMock = { assign: vi.fn(), reload: vi.fn() };
    vi.stubGlobal('location', locationMock);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderForm(props: Partial<React.ComponentProps<typeof LegalConsentForm>> = {}) {
    await act(async () => {
      root.render(
        <LegalConsentForm
          next="/menus/weekly"
          isReconsent={false}
          outdated={[...ALL_OUTDATED]}
          needsBirthDate={false}
          guardianMissing={false}
          {...props}
        />,
      );
    });
  }

  const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const declineButton = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('同意しない'))!;
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  async function checkBoth() {
    for (const checkbox of checkboxes()) {
      await act(async () => {
        checkbox.click();
      });
    }
  }

  async function submit() {
    await act(async () => {
      submitButton().click();
    });
  }

  it('チェックボックスは 2 つ (利用規約・プライバシーポリシー)。最初は両方未チェックで、「同意して続ける」は押せない', async () => {
    await renderForm();

    const boxes = checkboxes();
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    const labels = boxes.map((box) => box.closest('label')?.textContent ?? '');
    expect(labels[0]).toContain('利用規約');
    expect(labels[1]).toContain('プライバシーポリシー');
    expect(submitButton().textContent).toBe('同意して続ける');
    expect(submitButton().disabled).toBe(true);
  });

  it('2 つのチェックボックスは、どちらも必須として示す (required と aria-required="true")', async () => {
    await renderForm();

    const boxes = checkboxes();
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.required).toBe(true);
      expect(box.hasAttribute('required')).toBe(true);
      expect(box.getAttribute('aria-required')).toBe('true');
    }
  });

  it('必須の印を付けても、フォームはブラウザの検証で止めない (noValidate)。送れるかどうかは「同意して続ける」の無効化で決まる', async () => {
    await renderForm();

    const form = submitButton().closest('form')!;
    expect(form.noValidate).toBe(true);
    expect(submitButton().disabled).toBe(true);
    await checkBoth();
    expect(submitButton().disabled).toBe(false);
  });

  it('片方だけチェックしても押せない。両方チェックして初めて押せる。外すとまた押せない', async () => {
    await renderForm();

    await act(async () => {
      checkboxes()[0].click();
    });
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      checkboxes()[1].click();
    });
    expect(submitButton().disabled).toBe(false);

    await act(async () => {
      checkboxes()[0].click();
    });
    expect(submitButton().disabled).toBe(true);
  });

  it('両方の全文へのリンクは、同じタブで開く (アプリの WebView で開けなくなるのを避ける)', async () => {
    await renderForm();

    for (const type of LEGAL_DOCUMENT_TYPES) {
      const link = container.querySelector<HTMLAnchorElement>(`a[href="${LEGAL_DOCUMENT_PATHS[type]}"]`);
      expect(link, `${type} の全文へのリンク`).not.toBeNull();
      expect(link!.getAttribute('target')).toBeNull();
    }
  });

  it('版と施行日が、定数 (LEGAL_DOCUMENTS) から表示される', async () => {
    await renderForm();

    for (const type of LEGAL_DOCUMENT_TYPES) {
      const card = container.querySelector(`[data-testid="legal-doc-${type}"]`)!;
      expect(card.textContent).toContain(LEGAL_DOCUMENTS[type].version);
      expect(card.textContent).toContain(formatLegalEffectiveDate(LEGAL_DOCUMENTS[type].effectiveDate));
    }
  });

  it('★「同意して続ける」で、いま有効な版を POST /api/legal/accept に送り、成功したら戻り先へ (読み込み直し)', async () => {
    await renderForm({ next: '/menus/weekly?date=2026-10-08' });
    await checkBoth();
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/legal/accept');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ terms_version: CURRENT_TERMS, privacy_version: CURRENT_PRIVACY });
    expect(locationMock.assign).toHaveBeenCalledWith('/menus/weekly?date=2026-10-08');
    // 遷移するまで二重に押せない
    expect(submitButton().disabled).toBe(true);
  });

  it('★(#1442) 同意を記録できたら、アプリへの合図 notifyNativeLegalConsentAccepted を window.location.assign(next) より先に 1 回だけ送る', async () => {
    locationMock.assign.mockImplementation(() => {
      mocks.callOrder.push('location.assign');
    });
    await renderForm({ next: '/menus/weekly' });
    await checkBoth();
    await submit();

    expect(mocks.notifyNativeLegalConsentAccepted).toHaveBeenCalledTimes(1);
    expect(locationMock.assign).toHaveBeenCalledWith('/menus/weekly');
    expect(mocks.callOrder.filter((name) => name === 'notifyNativeLegalConsentAccepted' || name === 'location.assign')).toEqual([
      'notifyNativeLegalConsentAccepted',
      'location.assign',
    ]);
  });

  it.each([
    ['401', 401, { error: { code: 'AUTH_UNAUTHENTICATED' } }],
    ['403 LEGAL_MINOR_SELF_SIGNUP_REFUSED', 403, { error: { code: 'LEGAL_MINOR_SELF_SIGNUP_REFUSED' } }],
    ['400', 400, { error: { code: 'LEGAL_ACCEPT_FAILED' } }],
    ['409', 409, { error: { code: 'LEGAL_VERSION_MISMATCH' } }],
    ['500', 500, { error: { code: 'LEGAL_ACCEPT_FAILED' } }],
  ])('(#1442) 同意を記録できなかったとき (%s) は、アプリへの合図を送らない', async (_label, status, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body, status));
    await renderForm();
    await checkBoth();
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.notifyNativeLegalConsentAccepted).not.toHaveBeenCalled();
  });

  it('送信中は押せず、二重に送らない', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => (resolveFetch = resolve)));
    await renderForm();
    await checkBoth();

    await submit();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toContain('記録しています');
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(jsonResponse({ accepted: true }));
    });
    expect(locationMock.assign).toHaveBeenCalledTimes(1);
  });

  it('未ログイン (401) なら、ログイン画面へ。戻り先は、この同意画面', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'AUTH_UNAUTHENTICATED' } }, 401));
    await renderForm({ next: '/pantry' });
    await checkBoth();
    await submit();

    expect(locationMock.assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/legal-consent?next=${encodeURIComponent('/pantry')}`)}`,
    );
  });

  it('画面を開いたまま規約が更新された (409) ときは、読み込み直しを案内する。再読み込みボタンで読み込み直せる', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'LEGAL_VERSION_MISMATCH' } }, 409));
    await renderForm();
    await checkBoth();
    await submit();

    expect(alertText()).toContain('更新されました');
    expect(locationMock.assign).not.toHaveBeenCalled();
    const reload = Array.from(container.querySelectorAll('[role="alert"] button')).find((b) => b.textContent?.includes('読み込み直す'));
    expect(reload).toBeTruthy();
    await act(async () => {
      (reload as HTMLButtonElement).click();
    });
    expect(locationMock.reload).toHaveBeenCalledTimes(1);
  });

  it.each([500, 400])('それ以外の失敗 (%s) は汎用のエラー。チェックは残り、もう一度押せる', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'LEGAL_ACCEPT_FAILED', message: 'raw db error' } }, status));
    await renderForm();
    await checkBoth();
    await submit();

    expect(alertText()).toContain('同意の記録に失敗しました');
    expect(alertText()).not.toContain('raw db error');
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(checkboxes().every((box) => box.checked)).toBe(true);
    expect(submitButton().disabled).toBe(false);
  });

  it('通信エラーでも、案内を出して、もう一度押せる', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderForm();
    await checkBoth();
    await submit();

    expect(alertText()).toContain('通信に失敗しました');
    expect(submitButton().disabled).toBe(false);
  });

  it('チェックが揃っていないとき、フォームを送っても何も送らない', async () => {
    await renderForm();
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('初回の同意と再同意で、案内の文が変わる。再同意では改定された文書に「改定あり」が付く', async () => {
    await renderForm({ isReconsent: false });
    expect(container.textContent).toContain('ほめゴハンをご利用いただくには');
    expect(container.textContent).not.toContain('改定あり');
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await renderForm({ isReconsent: true, outdated: ['privacy_policy'] });
    expect(container.textContent).toContain('改定されました');
    const terms = container.querySelector('[data-testid="legal-doc-terms_of_service"]')!;
    const privacy = container.querySelector('[data-testid="legal-doc-privacy_policy"]')!;
    expect(terms.textContent).not.toContain('改定あり');
    expect(privacy.textContent).toContain('改定あり');
  });

  describe('「同意しない」', () => {
    it('★localStorage を消してから signOut し、ご利用いただけないことと、もう一度ログインすれば同意しなくても退会と書き出しができること (#1901 Q-23) を案内する。お問い合わせによる削除は約束しない。API は呼ばない', async () => {
      await renderForm();

      await act(async () => {
        declineButton().click();
      });

      expect(mocks.signOut).toHaveBeenCalledTimes(1);
      // CLAUDE.md の規約: Supabase の signOut より先に、利用者単位の localStorage を消す。続けて、ネイティブへ知らせる (#1038)
      expect(mocks.callOrder).toEqual(['clearUserScopedLocalStorage', 'notifyNativeSignOut', 'broadcastSignOut']);
      expect(mocks.clearUserScopedLocalStorage).toHaveBeenCalledTimes(1);
      expect(mocks.notifyNativeSignOut).toHaveBeenCalledTimes(1);
      expect(mocks.broadcastSignOut).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();

      const declined = container.querySelector('[data-testid="legal-consent-declined"]');
      expect(declined).not.toBeNull();
      expect(declined!.textContent).toContain('ご利用いただけません');
      // #1901 (cross/20 Q-23): 退会と書き出しは、もう一度ログインすれば同意しなくても本人が行える。ログインの後は退会と書き出しの画面へ戻る
      const accountGuide = declined!.querySelector('[data-testid="legal-consent-declined-account-guide"]');
      expect(accountGuide!.textContent).toContain(LEGAL_CONSENT_COPY.declinedAccountGuide);
      expect(accountGuide!.querySelector(`a[href="/login?next=${encodeURIComponent('/legal-consent/account')}"]`)?.textContent).toBe(
        LEGAL_CONSENT_COPY.declinedAccountLink,
      );
      // 運営が代わりに削除する経路は無いので、お問い合わせによる削除を約束しない (お問い合わせの窓口のリンクは残す)
      expect(declined!.textContent).not.toContain('ご本人であることを確認のうえ');
      expect(declined!.textContent).not.toContain('削除をご希望の場合は、お問い合わせ');
      expect(declined!.querySelector('a[href="/contact"]')).not.toBeNull();
      expect(declined!.querySelector('a[href="/login"]')).not.toBeNull();
      // 同意のフォームは消える
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('signOut の前に localStorage を消し、ネイティブへ知らせていること。broadcastSignOut は signOut のあと (呼び出し順)', async () => {
      const order: string[] = [];
      mocks.clearUserScopedLocalStorage.mockImplementation(() => order.push('clear'));
      mocks.notifyNativeSignOut.mockImplementation(() => order.push('notifyNative'));
      mocks.signOut.mockImplementation(async () => {
        order.push('signOut');
        return { error: null };
      });
      mocks.broadcastSignOut.mockImplementation(() => order.push('broadcast'));
      await renderForm();

      await act(async () => {
        declineButton().click();
      });

      expect(order).toEqual(['clear', 'notifyNative', 'signOut', 'broadcast']);
    });

    it('signOut に失敗したら、案内に進まず、エラーを出す。フォームはそのまま使える', async () => {
      mocks.signOut.mockRejectedValue(new Error('network'));
      await renderForm();

      await act(async () => {
        declineButton().click();
      });

      expect(alertText()).toContain('ログアウトに失敗しました');
      expect(container.querySelector('[data-testid="legal-consent-declined"]')).toBeNull();
      expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
      expect(checkboxes()).toHaveLength(2);
      expect(declineButton().disabled).toBe(false);
    });

    it('★supabase-js が例外でなく { error } を返したとき (通信失敗。サーバーのセッションは残る) も、「ログアウトしました」と案内せず、エラーを出す', async () => {
      mocks.signOut.mockResolvedValue({ error: { message: 'Failed to fetch', name: 'AuthRetryableFetchError', status: 0 } });
      await renderForm();

      await act(async () => {
        declineButton().click();
      });

      expect(alertText()).toContain('ログアウトに失敗しました');
      expect(container.querySelector('[data-testid="legal-consent-declined"]')).toBeNull();
      expect(mocks.broadcastSignOut).not.toHaveBeenCalled();
      expect(checkboxes()).toHaveLength(2);
      expect(declineButton().disabled).toBe(false);
    });

    it('チェックを入れていなくても「同意しない」は押せる', async () => {
      await renderForm();
      expect(declineButton().disabled).toBe(false);
    });

    it('「同意しない」の後の案内にも、開示・訂正・利用停止・消去の請求の画面 (/settings/data-requests) へのリンクを出す (#1751)', async () => {
      await renderForm();

      await act(async () => {
        declineButton().click();
      });

      const guide = container.querySelector('[data-testid="legal-consent-dsr-guide"]');
      expect(guide).not.toBeNull();
      expect(guide!.textContent).toContain('同意していなくても');
      expect(guide!.querySelector('a[href="/settings/data-requests"]')).not.toBeNull();
    });
  });

  describe('本人の権利の請求の案内 (#1751)', () => {
    it('同意のフォームの下に、同意せずに請求の画面 (/settings/data-requests) へ進むリンクを出す。押しても同意の API は呼ばない', async () => {
      await renderForm();

      const guide = container.querySelector('[data-testid="legal-consent-dsr-link"]');
      expect(guide).not.toBeNull();
      expect(guide!.textContent).toContain('開示・訂正・利用停止・消去');
      const link = guide!.querySelector<HTMLAnchorElement>('a[href="/settings/data-requests"]');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('target')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('再同意 (改定の後) のフォームにも同じリンクを出す', async () => {
      await renderForm({ isReconsent: true });

      expect(container.querySelector('[data-testid="legal-consent-dsr-link"] a[href="/settings/data-requests"]')).not.toBeNull();
    });
  });
});

describe('#1173 /legal-consent ページ (サーバー側) の生年月日と保護者の同意とのつながり (T-F6・T-F7)', () => {
  it('T-F6: isLegalConsentComplete なら next へ、birth_date だけ無い人にはフォームを needsBirthDate=true で出す。17 歳で rpc が true の人は next へ送る', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: null });
    const html = await renderPage({ next: '/pantry' });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain('name="birth_date"');
    expect(html).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.introBirthDateOnly);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(mocks.rpc).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: BIRTH_DATE_17 });
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(renderPage({ next: '/pantry' })).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/pantry');
    expect(mocks.rpc).toHaveBeenCalledWith('legal_minor_has_guardian_path');
  });

  it('T-F7: 17 歳で rpc が false の人には guardianMissing の案内だけを出す (生年月日の欄・チェック・「同意しない」は出さない)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: BIRTH_DATE_17 });
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });

    const html = await renderPage({ next: '/pantry' });

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading);
    expect(html).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('name="birth_date"');
    expect(html).not.toContain('同意しない');
  });
});

describe('#1173 /legal-consent フォーム (クライアント側) の生年月日と未成年の案内 (T-F1〜T-F5・T-F7)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let locationMock: { assign: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };

  function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ accepted: true }));
    vi.stubGlobal('fetch', fetchMock);
    locationMock = { assign: vi.fn(), reload: vi.fn() };
    vi.stubGlobal('location', locationMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderForm(props: Partial<React.ComponentProps<typeof LegalConsentForm>> = {}) {
    await act(async () => {
      root.render(
        <LegalConsentForm
          next="/menus/weekly"
          isReconsent={false}
          outdated={[...ALL_OUTDATED]}
          needsBirthDate
          guardianMissing={false}
          {...props}
        />,
      );
    });
  }

  const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const birthInput = () => container.querySelector<HTMLInputElement>('input[name="birth_date"]');
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const buttonWithText = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text)) ?? null;
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  async function setBirthDate(value: string) {
    const input = birthInput()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function checkBoth() {
    for (const checkbox of checkboxes()) {
      await act(async () => {
        checkbox.click();
      });
    }
  }

  async function click(button: HTMLButtonElement | null) {
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
  }

  it.each([
    ['新規 (S1)', { isReconsent: false, outdated: [...ALL_OUTDATED] }],
    ['版は同意済みで生年月日だけが無い (S3)', { isReconsent: true, outdated: [] }],
  ] as const)('T-F1: needsBirthDate のとき生年月日の欄 (required) が出て、チェックは最初どちらもオフ。欄だけでは押せず、欄 + 2 チェックで押せる。POST に birth_date が入る — %s', async (_name, props) => {
    await renderForm({ ...props, outdated: [...props.outdated] });

    const input = birthInput();
    expect(input).not.toBeNull();
    expect(input!.required).toBe(true);
    expect(input!.getAttribute('aria-required')).toBe('true');
    expect(checkboxes().every((box) => !box.checked)).toBe(true);
    expect(submitButton().disabled).toBe(true);

    await setBirthDate(ADULT_BIRTH_DATE);
    expect(submitButton().disabled).toBe(true);

    await checkBoth();
    expect(submitButton().disabled).toBe(false);

    await click(submitButton());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      terms_version: CURRENT_TERMS,
      privacy_version: CURRENT_PRIVACY,
      birth_date: ADULT_BIRTH_DATE,
    });

    if (props.isReconsent) {
      expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.introBirthDateOnly);
      expect(container.textContent).not.toContain('改定あり');
    } else {
      expect(container.textContent).not.toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.introBirthDateOnly);
    }
  });

  it('T-F1: 未来の日付では押せず、欄の下に invalid の文を出す', async () => {
    await renderForm();
    await checkBoth();
    await setBirthDate('2999-01-01');
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.invalid);
  });

  it('T-F2: needsBirthDate が false のとき欄は出ず、POST に birth_date を入れない', async () => {
    await renderForm({ needsBirthDate: false });
    expect(birthInput()).toBeNull();
    await checkBoth();
    await click(submitButton());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ terms_version: CURRENT_TERMS, privacy_version: CURRENT_PRIVACY });
  });

  it('T-F1: 400 LEGAL_BIRTH_DATE_INVALID は欄のエラーにする', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'LEGAL_BIRTH_DATE_INVALID' } }, 400));
    await renderForm();
    await setBirthDate(ADULT_BIRTH_DATE);
    await checkBoth();
    await click(submitButton());
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.invalid);
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  async function reachMinorRefused() {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'LEGAL_MINOR_SELF_SIGNUP_REFUSED' } }, 403));
    await renderForm();
    await setBirthDate('2011-04-01');
    await checkBoth();
    await click(submitButton());
  }

  it('T-F3: 403 LEGAL_MINOR_SELF_SIGNUP_REFUSED で案内 (見出し・2 つのボタン) が出る。フォームは出ない (S4)', async () => {
    await reachMinorRefused();

    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedHeading);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody);
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.fixButton)).not.toBeNull();
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton)).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(checkboxes()).toHaveLength(0);
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  /** 同意しなくても退会と書き出しができる画面 (/legal-consent/account) へのリンク (#1901 cross/20 Q-23) */
  const accountEntryLink = () =>
    container.querySelector<HTMLAnchorElement>('[data-testid="legal-consent-account-link"] a[href="/legal-consent/account"]');

  it('#1901 Q-23: 同意のフォームの下に、同意しなくても退会と書き出しができる画面 (/legal-consent/account) へのリンクがある', async () => {
    await renderForm();

    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector('[data-testid="legal-consent-account-link"]')?.textContent).toContain(LEGAL_CONSENT_COPY.accountEntryLead);
    expect(accountEntryLink()?.textContent).toBe(LEGAL_CONSENT_COPY.accountEntryLink);
  });

  it('#1901 Q-23: 18 歳未満の案内 (minor_refused・guardian_missing) にも、退会と書き出しの画面へのリンクがある', async () => {
    await reachMinorRefused();
    expect(accountEntryLink()?.textContent).toBe(LEGAL_CONSENT_COPY.accountEntryLink);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm({ guardianMissing: true });
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading);
    expect(accountEntryLink()?.textContent).toBe(LEGAL_CONSENT_COPY.accountEntryLink);
  });

  it('T-F4: 「生年月日を直す」でフォームに戻り、入力を直して送り直せる (S5)', async () => {
    await reachMinorRefused();
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.fixButton));

    expect(birthInput()).not.toBeNull();
    fetchMock.mockResolvedValue(jsonResponse({ accepted: true }));
    await setBirthDate(ADULT_BIRTH_DATE);
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).birth_date).toBe(ADULT_BIRTH_DATE);
    expect(locationMock.assign).toHaveBeenCalledWith('/menus/weekly');
  });

  it('T-F5: 「登録をやめる」で deleteOwnAccount → signOutAfterAccountDeletion の順に呼び、「登録をやめました」が出る', async () => {
    await reachMinorRefused();
    mocks.callOrder.length = 0;
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton));

    expect(mocks.callOrder).toEqual(['deleteOwnAccount', 'signOutAfterAccountDeletion']);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnHeading);
    expect(container.querySelector('a[href="/signup"]')).not.toBeNull();
  });

  it.each([
    ['failed', { kind: 'failed' }, ACCOUNT_DELETE_FAILED_MESSAGE],
    ['unauthorized', { kind: 'unauthorized' }, ACCOUNT_DELETE_FAILED_MESSAGE],
    ['blocked', { kind: 'blocked', message: '代表者のため退会できません', blocker: 'family_group' }, accountDeletionBlockedMessage('代表者のため退会できません')],
  ] as const)('T-F5: deleteOwnAccount が %s なら案内に戻り、文を出す (signOutAfterAccountDeletion を呼ばない)', async (_name, result, message) => {
    await reachMinorRefused();
    mocks.deleteOwnAccount.mockResolvedValue(result);
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton));

    expect(mocks.signOutAfterAccountDeletion).not.toHaveBeenCalled();
    expect(alertText()).toContain(message);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedHeading);
    expect(container.textContent).not.toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnHeading);
  });

  it('billing/03: minor_refused と guardianMissing の案内に、STORE_SUBSCRIPTION_DELETION_NOTICE の文を「登録をやめる」と一緒に出す', async () => {
    // 案内の画面の見出しと本文の区画 (h1 の親) に、ストアの購読は退会で解約されない文がちょうど 1 回出る (billing/03 §10.4・S35)
    const noticeInHeadingBlock = () => {
      const heading = container.querySelector('h1');
      expect(heading, '案内の見出し').not.toBeNull();
      return Array.from(heading!.parentElement!.querySelectorAll('p')).filter((p) => p.textContent === STORE_SUBSCRIPTION_DELETION_NOTICE);
    };

    await reachMinorRefused();
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedHeading);
    expect(noticeInHeadingBlock()).toHaveLength(1);
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton)).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm({ guardianMissing: true });
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading);
    expect(noticeInHeadingBlock()).toHaveLength(1);
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton)).not.toBeNull();

    // 同意のフォーム (案内でない画面) には出さない
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderForm();
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.textContent).not.toContain(STORE_SUBSCRIPTION_DELETION_NOTICE);
  });

  it('T-F7: guardianMissing のときは「保護者の同意とのつながりがありません」と「登録をやめる」だけを出す (生年月日の欄・チェック・「同意しない」は出ない)', async () => {
    await renderForm({ guardianMissing: true });

    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingBody);
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton)).not.toBeNull();
    expect(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.fixButton)).toBeNull();
    expect(buttonWithText('同意しない')).toBeNull();
    expect(birthInput()).toBeNull();
    expect(checkboxes()).toHaveLength(0);
  });

  it('T-F7: guardianMissing の「登録をやめる」は deleteOwnAccount → signOutAfterAccountDeletion の順で「登録をやめました」', async () => {
    await renderForm({ guardianMissing: true });
    mocks.callOrder.length = 0;
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton));

    expect(mocks.callOrder).toEqual(['deleteOwnAccount', 'signOutAfterAccountDeletion']);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnHeading);
  });

  it.each([
    ['failed', { kind: 'failed' }, ACCOUNT_DELETE_FAILED_MESSAGE],
    ['blocked', { kind: 'blocked', message: null, blocker: null }, accountDeletionBlockedMessage(null)],
  ] as const)('T-F7: guardianMissing の「登録をやめる」が %s なら guardian_missing の案内に戻って文を出す', async (_name, result, message) => {
    await renderForm({ guardianMissing: true });
    mocks.deleteOwnAccount.mockResolvedValue(result);
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton));

    expect(mocks.signOutAfterAccountDeletion).not.toHaveBeenCalled();
    expect(alertText()).toContain(message);
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.guardianMissingHeading);
  });

  it('退会の送信中はボタンを無効にし、「削除しています...」を出す', async () => {
    let resolveDelete: (value: unknown) => void = () => {};
    mocks.deleteOwnAccount.mockImplementation(() => new Promise((resolve) => (resolveDelete = resolve)));
    await renderForm({ guardianMissing: true });
    await click(buttonWithText(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawButton));

    const busy = buttonWithText('削除しています...');
    expect(busy).not.toBeNull();
    expect(busy!.disabled).toBe(true);

    await act(async () => {
      resolveDelete({ kind: 'deleted' });
    });
    expect(container.textContent).toContain(LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnHeading);
  });
});
