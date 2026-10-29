/**
 * #2086 V2: 家族の昇格の承諾の画面 (/family/promotions/[token]) の承諾・拒否の通信が切れたあとの読み直し。
 *
 * サーバーが承諾 / 拒否を済ませてから応答が切れると、以前は「通信エラーが発生しました」だけを出し、押し直すと
 * PROMOTION_REQUEST_ALREADY_USED で「この参加リクエストは既に処理済みです。」となって、承諾できたのか拒否されたのか分からなかった。
 * 本文が JSON でない失敗の応答 (プロキシの 502 など) も、ok の確認より先に res.json() を読んで例外になり、通信エラーに落ちていた。
 * 今は get_promotion_details を読み直して status で出し分ける (招待の承諾の FamilyInviteAcceptModal (#2080 U1) と同じ型)。
 *
 * あわせて (#2086 V3 と同じ型) 画面を開いたときに自分 (getUser) や参加リクエストを読み込めなかったときは、
 * ログインの案内や「参加リクエストが見つかりません」と見せず、読み込めなかった文と「再試行」を出す。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

const ids = vi.hoisted(() => ({
  ME: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  TOKEN: 'b'.repeat(64),
}));

// 本物の useRouter は同じ参照を返す (毎回作ると useEffect の依存が変わって読み込みが 2 回走る)
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ token: ids.TOKEN }),
  useRouter: () => router,
}));

// 拒否の確認のダイアログのフォーカストラップは関心外 (jsdom では tabbable の判定ができず例外になる)。中身をそのまま出す
vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

type PromotionStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
type RpcResult = { data: unknown; error: unknown };

const state = vi.hoisted(() => ({
  /** get_promotion_details の応答を順に返す (尽きたら最後のものを返し続ける)。関数なら呼ぶ (reject させたいとき) */
  rpcResults: [] as Array<RpcResult | (() => Promise<RpcResult>)>,
  rpcCalls: 0,
  getUser: null as null | (() => Promise<{ data: { user: unknown }; error: unknown }>),
}));

const client = vi.hoisted(() => ({
  auth: {
    getUser: () => state.getUser!(),
    signOut: async () => ({ error: null }),
  },
  rpc: async (fn: string) => {
    if (fn !== 'get_promotion_details') throw new Error(`unexpected rpc ${fn}`);
    const index = Math.min(state.rpcCalls, state.rpcResults.length - 1);
    state.rpcCalls += 1;
    const next = state.rpcResults[index];
    return typeof next === 'function' ? next() : next;
  },
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));

const { default: PromotionConsentPage } = await import('@/app/family/promotions/[token]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NETWORK_FAILURE_MESSAGE = '通信エラーが発生しました';
const ALREADY_USED_MESSAGE = 'この参加リクエストは既に処理済みです。';
const NOT_PROCESSED_MESSAGE = '応答を受け取れませんでした。参加リクエストはまだ処理されていません。もう一度お試しください。';
const LOAD_ERROR = '参加リクエストを読み込めませんでした。しばらくしてから、もう一度お試しください。';
const ACCEPTED_HEADING = '家族グループに参加しました';
const REJECTED_HEADING = '参加リクエストを拒否しました';
const NOT_FOUND_HEADING = '参加リクエストが見つかりません';

/** fetch が reject したときの例外 (オフライン) */
const NETWORK_DOWN = new TypeError('Failed to fetch');
/** getUser が通信の失敗で返す error (auth-js は投げずに { user: null, error } で返す) */
const AUTH_NETWORK_ERROR = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
/** getUser がログインしていないときに返す error */
const AUTH_SESSION_MISSING = { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' };

function details(status: PromotionStatus) {
  return {
    family_name: '山田家',
    member_display_name: 'たろう',
    requested_by_name: '山田花子',
    email: 'taro@example.com',
    status,
    expires_at: '2999-01-01T00:00:00.000Z',
    current_user_email_matches: true,
  };
}

function rpcOk(status: PromotionStatus): RpcResult {
  return { data: details(status), error: null };
}

const RPC_LOAD_FAILURE: RpcResult = { data: null, error: { code: 'PGRST000', message: 'Failed to fetch' } };

/** 応答の形: ok / status / json (本文が JSON でないときは json が reject する) */
function jsonResponse(body: unknown, status: number) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}
function nonJsonResponse(status: number) {
  return { ok: false, status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderPage() {
  await act(async () => {
    root.render(<PromotionConsentPage />);
  });
  await flush();
}

function text(): string {
  return container.textContent ?? '';
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(label));
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}

async function accept() {
  await click(findButton('参加を承認する'));
}

async function reject() {
  await click(findButton('拒否する'));
  // 確認のダイアログの「拒否する」(赤いボタン。dialog の中)
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const confirm = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes('拒否する'),
  );
  await click(confirm);
}

function alertText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  state.rpcResults = [rpcOk('pending')];
  state.rpcCalls = 0;
  state.getUser = async () => ({ data: { user: { id: ids.ME, email: 'taro@example.com' } }, error: null });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  vi.restoreAllMocks();
});

describe('#2086 V2 承諾の通信が切れたあと、参加リクエストを読み直して出し分ける', () => {
  it('サーバーが承諾を済ませていた (読み直すと承認済み) なら、承諾の成功と同じ画面 (家族ダッシュボードへの導線) を出す', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('accepted')];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(state.rpcCalls).toBe(2);
    expect(text()).toContain(ACCEPTED_HEADING);
    expect(text()).not.toContain(NETWORK_FAILURE_MESSAGE);
    await click(findButton('家族ダッシュボードへ'));
    expect(router.push).toHaveBeenCalledWith('/family/dashboard');
  });

  it('読み直すと承認待ちのまま (処理されていない) なら、まだ処理されていない文を出し、もう一度押せる', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('pending')];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(alertText()).toBe(NOT_PROCESSED_MESSAGE);
    expect(text()).not.toContain(ACCEPTED_HEADING);
    expect(findButton('参加を承認する')?.disabled).toBe(false);
  });

  it('読み直しにも失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    state.rpcResults = [rpcOk('pending'), RPC_LOAD_FAILURE];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(alertText()).toBe(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
    expect(text()).not.toContain(ACCEPTED_HEADING);
  });

  it('読み直しの問い合わせが例外を投げても、未処理の reject にせず「状態を確かめられませんでした」を添える', async () => {
    state.rpcResults = [rpcOk('pending'), () => Promise.reject(NETWORK_DOWN)];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(alertText()).toBe(`${NETWORK_FAILURE_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
  });

  it('本文が JSON でない失敗の応答 (502) でも、例外の文に落とさず読み直す (承認済みなら成功の画面)', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('accepted')];
    fetchMock.mockResolvedValue(nonJsonResponse(502));
    await renderPage();
    await accept();

    expect(state.rpcCalls).toBe(2);
    expect(text()).toContain(ACCEPTED_HEADING);
  });

  it('本文が JSON でない失敗の応答 (504) で、読み直すと承認待ちなら、まだ処理されていない文を出す', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('pending')];
    fetchMock.mockResolvedValue(nonJsonResponse(504));
    await renderPage();
    await accept();

    expect(alertText()).toBe(NOT_PROCESSED_MESSAGE);
  });

  it('成功の応答の本文が読めなくても、承諾の成功として扱う (読み直さない)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('x')) });
    await renderPage();
    await accept();

    expect(state.rpcCalls).toBe(1);
    expect(text()).toContain(ACCEPTED_HEADING);
  });

  it('PROMOTION_REQUEST_ALREADY_USED で断られたら読み直し、承認済みなら承諾の成功と同じ画面にする', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('accepted')];
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_ALREADY_USED', message: '参加の承認に失敗しました' } }, 409));
    await renderPage();
    await accept();

    expect(text()).toContain(ACCEPTED_HEADING);
    expect(text()).not.toContain(ALREADY_USED_MESSAGE);
  });

  it('PROMOTION_REQUEST_ALREADY_USED で、読み直すと拒否済みなら、拒否の成功と同じ画面にする', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('rejected')];
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_ALREADY_USED', message: 'x' } }, 409));
    await renderPage();
    await accept();

    expect(text()).toContain(REJECTED_HEADING);
    expect(text()).not.toContain(ACCEPTED_HEADING);
  });

  it('PROMOTION_REQUEST_ALREADY_USED で、読み直せなければ処理済みの文に「状態を確かめられませんでした」を添える', async () => {
    state.rpcResults = [rpcOk('pending'), RPC_LOAD_FAILURE];
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_ALREADY_USED', message: 'x' } }, 409));
    await renderPage();
    await accept();

    expect(alertText()).toBe(`${ALREADY_USED_MESSAGE} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})`);
  });

  it('読み直すと取り消し済みなら、読み直した状態 (「このリクエストは無効です」取り消し済み) を出す', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('revoked')];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(text()).toContain('このリクエストは無効です');
    expect(text()).toContain('取り消し済み');
    expect(findButton('参加を承認する')).toBeUndefined();
  });

  it('ほかのコード (PROMOTION_REQUEST_EXPIRED) は読み直さず、これまでどおりコードの文を出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_EXPIRED', message: 'x' } }, 410));
    await renderPage();
    await accept();

    expect(state.rpcCalls).toBe(1);
    expect(alertText()).toBe('この参加リクエストの期限が切れています。ご家族に再送を依頼してください。');
  });

  it('読み直しの応答を待つあいだは「参加を承認する」を止めたままにする', async () => {
    let resolveReread: (value: RpcResult) => void = () => {};
    state.rpcResults = [rpcOk('pending'), () => new Promise<RpcResult>((resolve) => (resolveReread = resolve))];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await accept();

    expect(findButton('処理中')?.disabled).toBe(true);
    await act(async () => {
      resolveReread(rpcOk('pending'));
    });
    await flush();
    expect(findButton('参加を承認する')?.disabled).toBe(false);
  });
});

describe('#2086 V2 拒否の通信が切れたあと、参加リクエストを読み直して出し分ける', () => {
  it('サーバーが拒否を済ませていた (読み直すと拒否済み) なら、拒否の成功と同じ画面を出す', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('rejected')];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await reject();

    expect(text()).toContain(REJECTED_HEADING);
    expect(text()).not.toContain(NETWORK_FAILURE_MESSAGE);
  });

  it('読み直すと承認待ちのままなら、まだ処理されていない文を出す', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('pending')];
    fetchMock.mockRejectedValue(NETWORK_DOWN);
    await renderPage();
    await reject();

    expect(alertText()).toBe(NOT_PROCESSED_MESSAGE);
    expect(text()).not.toContain(REJECTED_HEADING);
  });

  it('本文が JSON でない失敗の応答 (502) でも読み直す (拒否済みなら拒否の成功の画面)', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('rejected')];
    fetchMock.mockResolvedValue(nonJsonResponse(502));
    await renderPage();
    await reject();

    expect(text()).toContain(REJECTED_HEADING);
  });

  it('PROMOTION_REQUEST_ALREADY_USED で、読み直すと承認済みなら、承諾の成功と同じ画面にする', async () => {
    state.rpcResults = [rpcOk('pending'), rpcOk('accepted')];
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'PROMOTION_REQUEST_ALREADY_USED', message: 'x' } }, 409));
    await renderPage();
    await reject();

    expect(text()).toContain(ACCEPTED_HEADING);
  });
});

describe('#2086 画面を開いたときの読み込みの失敗 (V3 と同じ型)', () => {
  it('getUser が通信の失敗 ({ user: null, error }) なら、ログインの案内を出さず、読み込めなかった文と「再試行」を出す', async () => {
    state.getUser = async () => ({ data: { user: null }, error: AUTH_NETWORK_ERROR });
    await renderPage();

    expect(container.querySelector('[data-testid="promotion-load-error"]')?.textContent).toContain(LOAD_ERROR);
    expect(findButton('ログインする')).toBeUndefined();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('ログインしていない (AuthSessionMissingError) なら、これまでどおりログインの案内を出す', async () => {
    state.getUser = async () => ({ data: { user: null }, error: AUTH_SESSION_MISSING });
    await renderPage();

    expect(container.querySelector('[data-testid="promotion-load-error"]')).toBeNull();
    expect(findButton('ログインする')).toBeDefined();
  });

  it('get_promotion_details を読み込めなかったら、「参加リクエストが見つかりません」と見せず、読み込めなかった文を出す', async () => {
    state.rpcResults = [RPC_LOAD_FAILURE];
    await renderPage();

    expect(container.querySelector('[data-testid="promotion-load-error"]')?.textContent).toContain(LOAD_ERROR);
    expect(text()).not.toContain(NOT_FOUND_HEADING);
  });

  it('リクエストが無い (data が null) なら、これまでどおり「参加リクエストが見つかりません」を出す', async () => {
    state.rpcResults = [{ data: null, error: null }];
    await renderPage();

    expect(text()).toContain(NOT_FOUND_HEADING);
    expect(container.querySelector('[data-testid="promotion-load-error"]')).toBeNull();
  });

  it('「再試行」で読み直し、読めたら承諾のカードを出す', async () => {
    state.rpcResults = [RPC_LOAD_FAILURE, rpcOk('pending')];
    await renderPage();
    await click(findButton('再試行'));

    expect(container.querySelector('[data-testid="promotion-load-error"]')).toBeNull();
    expect(findButton('参加を承認する')).toBeDefined();
  });
});
