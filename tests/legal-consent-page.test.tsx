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
 *     ご利用いただけないことと、データ削除の依頼先 (お問い合わせ) を案内する。
 *     API は呼ばない。signOut に失敗したら案内に進まず、エラーを出す
 *
 * このリポジトリには @testing-library/react が無いため、サーバー側は react-dom/server、フォームは react-dom/client + act で描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_PATHS,
  LEGAL_DOCUMENT_TYPES,
  formatLegalEffectiveDate,
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
  broadcastSignOut: vi.fn(),
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
}));

const { default: LegalConsentPage } = await import('@/app/legal-consent/page');
const { default: LegalConsentForm } = await import('@/app/legal-consent/LegalConsentForm');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const ALL_OUTDATED = ['terms_of_service', 'privacy_policy'] as const;

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
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY });

    await expect(renderPage({ next: '/menus/weekly?date=2026-10-08' })).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledWith('/menus/weekly?date=2026-10-08');
  });

  it('戻り先が無い・安全でないときは /home', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY });

    for (const next of [undefined, '', 'https://evil.example/', '//evil.example/', '/legal-consent', '/api/account/export']) {
      mocks.redirect.mockClear();
      await expect(renderPage({ next })).rejects.toThrow('NEXT_REDIRECT');
      expect(mocks.redirect).toHaveBeenCalledWith('/home');
    }
  });

  it('next が複数あっても、先頭だけを使う', async () => {
    profileRow({ terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY });

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
      root.render(<LegalConsentForm next="/menus/weekly" isReconsent={false} outdated={[...ALL_OUTDATED]} {...props} />);
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
    it('★localStorage を消してから signOut し、ご利用いただけないことと、データ削除の依頼先 (お問い合わせ) を案内する。API は呼ばない', async () => {
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
      expect(declined!.textContent).toContain('削除');
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

    it('★supabase-js が例外でなく { error } を返したとき (通信失敗。セッションは残る) も、「ログアウトしました」と案内せず、エラーを出す', async () => {
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
  });
});
