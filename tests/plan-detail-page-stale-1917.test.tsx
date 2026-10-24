/**
 * #1917 プラン詳細画面 (/super-admin/plans/[id]) が、409 CONFLICT_STALE_DATA (読んでから書くまでに別の運営が先にプランを変えた)
 * のあとに自分でプランを読み直すテスト
 *
 * 以前は保存の 409 は API の文を出すだけ、公開・非公開・廃止・廃止の取り消しの 409 は alert を出すだけで、画面に古い状態と
 * ボタンが残っていた (API の文に従って運営が手で読み込み直す必要があった)。修正後は次のようになる。
 *   - 保存・公開・非公開・廃止・廃止の取り消しが 409 CONFLICT_STALE_DATA なら、プランを読み直して今の状態とボタンを出し、
 *     読み直した旨を画面の上に出す (サーバーの「画面を読み込み直して」は出さない・alert も出さない)
 *   - 表示名・説明・表示順の入力欄は、書きかけ (最後に読んだ値から変えた) の欄だけ残し、ほかは読み直した値にする
 *   - 読み直しに失敗したら「読み込み直した」とは出さず、画面と入力欄を残して、文と「再試行」を出す。「再試行」で読み直せたら
 *     読み直した旨の文に変える
 *   - 保存・状態の変更に成功したあとの読み直しに失敗しても、画面をエラーに置き換えず、文と「再試行」を出す
 *   - 同じ 409 でも code が違う (契約者がいる OP_PLAN_HAS_SUBSCRIBERS など) ときは読み直さず、これまでどおり API の文を出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN = {
  id: 'plan-1',
  plan_key: 'pro',
  display_name: 'Pro',
  plan_type: 'personal',
  description: '個人向け',
  monthly_price_jpy: 1500,
  yearly_price_jpy: 15000,
  max_members: null,
  stripe_product_id: null,
  stripe_price_id: null,
  stripe_yearly_price_id: null,
  status: 'private',
  display_order: 1,
  trial_days: 0,
  feature_packages: [],
  price_history: [],
};

const SERVER_STALE_MESSAGE = '別の運営が先にこのプランを変えました。画面を読み込み直して、もう一度確認してください';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const staleResponse = () => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: SERVER_STALE_MESSAGE } });

interface ApiOptions {
  /** 1 回目の PATCH の応答 (2 回目以降は 200) */
  patch: () => Response;
  /** PATCH のあとに GET が返すプラン (別の運営の変更が入ったもの) */
  planAfterPatch?: typeof PLAN;
  /** n 回目 (1 始まり) の GET を失敗させる (HTTP ステータスは failGetStatus) */
  failGets?: number[];
  /** failGets の GET の HTTP ステータス (既定は 500) */
  failGetStatus?: number;
}

/** GET の失敗の応答の本文 (HTTP ステータスごと。route の形) */
const GET_FAILURE_BODIES: Record<number, unknown> = {
  403: { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
  404: { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } },
  500: { error: { code: 'INTERNAL_ERROR', message: 'プランの取得に失敗しました' } },
};

function mockApi(options: ApiOptions) {
  const state = { patched: false, gets: 0, patches: 0 };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      state.patches += 1;
      if (state.patches > 1) return jsonResponse(200, { data: PLAN });
      state.patched = true;
      return options.patch();
    }
    state.gets += 1;
    if (options.failGets?.includes(state.gets)) {
      const status = options.failGetStatus ?? 500;
      return jsonResponse(status, GET_FAILURE_BODIES[status]);
    }
    return jsonResponse(200, { data: state.patched && options.planAfterPatch ? options.planAfterPatch : PLAN });
  });
  vi.stubGlobal('fetch', fetchMock);
  return state;
}

const text = () => container.textContent ?? '';
const notice = () => container.querySelector('[data-testid="plan-reload-notice"]');
const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

const displayNameInput = () => container.querySelector('input[type="text"]') as HTMLInputElement;
const descriptionInput = () => container.querySelector('textarea') as HTMLTextAreaElement;
const displayOrderInput = () => container.querySelector('input[type="number"]') as HTMLInputElement;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage() {
  await act(async () => {
    root.render(<PlanDetailPage />);
  });
  await settle();
}

async function click(label: string) {
  const button = findButton(label);
  expect(button, `「${label}」ボタンが見つからない`).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await settle();
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('2027-01-01');
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

describe('状態の変更が 409 CONFLICT_STALE_DATA で断られたとき (#1917)', () => {
  it('「再公開する」が 409 なら、プランを読み直して今の状態 (廃止) とボタンを出し、読み直した旨を出す (alert もサーバーの文も出さない)', async () => {
    const state = mockApi({ patch: staleResponse, planAfterPatch: { ...PLAN, status: 'deprecated' } });
    await renderPage();
    expect(text()).toContain('非公開');

    await click('再公開する');

    expect(state.gets).toBe(2); // 初回 + 読み直し
    expect(alertSpy).not.toHaveBeenCalled();
    expect(text()).toContain('廃止');
    expect(findButton('廃止を取り消す')).toBeDefined();
    expect(findButton('再公開する')).toBeUndefined();
    expect(notice()?.textContent).toContain('別の運営が先にこのプランを変えていました');
    expect(notice()?.textContent).toContain('読み込み直したので');
    expect(notice()?.textContent).not.toContain('画面を読み込み直して');
    // 読み直せたので「再試行」は出さない
    expect(notice()?.querySelector('button')).toBeNull();
  });

  it('「廃止する」が 409 CONFLICT_STALE_DATA でも読み直して文を出す', async () => {
    const state = mockApi({ patch: staleResponse, planAfterPatch: { ...PLAN, status: 'public' } });
    await renderPage();

    await click('廃止する');

    expect(patchBodies()[0]).toEqual({ status: 'deprecated', ends_at: '2027-01-01T00:00:00.000Z' });
    expect(state.gets).toBe(2);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(text()).toContain('公開中');
    expect(notice()?.textContent).toContain('読み込み直したので');
  });

  it('「廃止を取り消す」が 409 CONFLICT_STALE_DATA でも読み直して文を出す', async () => {
    const deprecated = { ...PLAN, status: 'deprecated' };
    let gets = 0;
    let patched = false;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patched = true;
        return staleResponse();
      }
      gets += 1;
      return jsonResponse(200, { data: patched ? { ...PLAN, status: 'private' } : deprecated });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();

    await click('廃止を取り消す');

    expect(gets).toBe(2);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('再公開する')).toBeDefined();
    expect(notice()?.textContent).toContain('読み込み直したので');
  });

  it('同じ 409 でも code が CONFLICT_STALE_DATA でなければ (契約者がいる)、読み直さずに API の文を alert で出す', async () => {
    const state = mockApi({
      patch: () => jsonResponse(409, { error: { code: 'OP_PLAN_HAS_SUBSCRIBERS', message: '契約者がいるため、このプランは廃止できません' } }),
    });
    await renderPage();

    await click('廃止する');

    expect(state.gets).toBe(1);
    expect(alertSpy).toHaveBeenCalledWith('契約者がいるため、このプランは廃止できません');
    expect(notice()).toBeNull();
  });

  it('読み直しに失敗したら、画面を残して「読み込み直せませんでした」と「再試行」を出す。「再試行」で読み直せたら読み直した旨の文に変える', async () => {
    const state = mockApi({ patch: staleResponse, planAfterPatch: { ...PLAN, status: 'deprecated' }, failGets: [2] });
    await renderPage();

    await click('再公開する');

    expect(state.gets).toBe(2);
    // 画面はエラーに置き換えない (古い状態のまま残す)
    expect(text()).toContain('Pro');
    expect(findButton('再公開する')).toBeDefined();
    expect(notice()?.textContent).toContain('読み込み直せませんでした');
    expect(notice()?.textContent).not.toContain('読み込み直したので');

    await click('再試行');

    expect(state.gets).toBe(3);
    expect(findButton('廃止を取り消す')).toBeDefined();
    expect(notice()?.textContent).toContain('読み込み直したので');
    expect(notice()?.textContent).not.toContain('読み込み直せませんでした');
    expect(notice()?.querySelector('button')).toBeNull();
  });
});

describe('保存が 409 CONFLICT_STALE_DATA で断られたとき (#1917)', () => {
  it('プランを読み直し、書きかけの欄は残して、書きかけでない欄は読み直した値にする。文は画面の上に出し、保存の欄にサーバーの文を出さない', async () => {
    const state = mockApi({
      patch: staleResponse,
      planAfterPatch: { ...PLAN, status: 'public', description: '別の運営の説明', display_order: 5 },
    });
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');

    await click('保存する');

    // 送るのは変えた表示名だけ (手を付けていない説明・表示順は送らない)
    expect(patchBodies()[0]).toEqual({ display_name: 'Pro プラス' });
    expect(state.gets).toBe(2);
    expect(text()).toContain('公開中');
    // 書きかけ (表示名) は残し、手を付けていない欄 (説明・表示順) は読み直した値
    expect(displayNameInput().value).toBe('Pro プラス');
    expect(descriptionInput().value).toBe('別の運営の説明');
    expect(displayOrderInput().value).toBe('5');
    expect(notice()?.textContent).toContain('読み込み直したので');
    expect(notice()?.textContent).toContain('入力中の表示名・説明・表示順はそのまま残しています');
    expect(text()).not.toContain('画面を読み込み直して');
    expect(text()).not.toContain('保存しました');

    // もう一度保存すると、書きかけの表示名だけを送る (読み直した説明・表示順は別の運営の値のまま。送って書き直さない)
    await click('保存する');
    expect(patchBodies()[1]).toEqual({ display_name: 'Pro プラス' });
    expect(notice()).toBeNull();
    expect(text()).toContain('保存しました');
  });

  it('入力欄に手を付けていなければ、全部を読み直した値にし、「残しています」は出さない', async () => {
    // 入力欄に手を付けていなければ保存は送らない (#1917) ので、409 は状態の変更 (廃止) で起こす
    mockApi({ patch: staleResponse, planAfterPatch: { ...PLAN, display_name: 'Pro (改)', description: '別の運営の説明' } });
    await renderPage();

    await click('廃止する');

    expect(displayNameInput().value).toBe('Pro (改)');
    expect(descriptionInput().value).toBe('別の運営の説明');
    expect(notice()?.textContent).toContain('読み込み直したので');
    expect(notice()?.textContent).not.toContain('残しています');
  });

  it('読み直しに失敗しても入力欄の書きかけを残し、「読み込み直せませんでした」と「再試行」を出す', async () => {
    mockApi({ patch: staleResponse, planAfterPatch: { ...PLAN, description: '別の運営の説明' }, failGets: [2] });
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');

    await click('保存する');

    expect(displayNameInput().value).toBe('Pro プラス');
    expect(descriptionInput().value).toBe('個人向け');
    expect(notice()?.textContent).toContain('読み込み直せませんでした');
    expect(notice()?.textContent).toContain('残しています');
    expect(findButton('再試行')).toBeDefined();

    await click('再試行');
    expect(displayNameInput().value).toBe('Pro プラス');
    expect(descriptionInput().value).toBe('別の運営の説明');
    expect(notice()?.textContent).toContain('読み込み直したので');
  });
});

describe('成功したあとの読み直し (#1917)', () => {
  it('保存に成功したあとの読み直しに失敗しても、画面をエラーに置き換えず、文と「再試行」を出す', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse(200, { data: PLAN });
      gets += 1;
      if (gets === 2) return jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'プランの取得に失敗しました' } });
      return jsonResponse(200, { data: PLAN });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');

    await click('保存する');

    expect(gets).toBe(2);
    expect(text()).toContain('保存しました');
    expect(displayNameInput()).not.toBeNull();
    expect(notice()?.textContent).toContain('最新の内容を読み込めませんでした');

    await click('再試行');
    expect(gets).toBe(3);
    expect(notice()).toBeNull();
  });

  it('初めの読み込みに失敗したときは、これまでどおり画面をエラーにする', async () => {
    fetchMock = vi.fn(async () => jsonResponse(404, { error: { code: 'OP_PLAN_NOT_FOUND', message: 'プランが見つかりません' } }));
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();

    expect(text()).toContain('プランが見つかりません');
    expect(displayNameInput()).toBeNull();
  });
});

describe('保存は変えた欄だけを送る (#1917)', () => {
  it('説明だけを変えたら説明だけを送り、手を付けていない表示名・表示順は送らない', async () => {
    mockApi({ patch: () => jsonResponse(200, { data: PLAN }) });
    await renderPage();
    await typeInto(descriptionInput(), '説明を直した');

    await click('保存する');

    expect(patchBodies()).toEqual([{ description: '説明を直した' }]);
    expect(text()).toContain('保存しました');
  });

  it('表示順だけを変えたら表示順だけを送る', async () => {
    mockApi({ patch: () => jsonResponse(200, { data: PLAN }) });
    await renderPage();
    await typeInto(displayOrderInput(), '7');

    await click('保存する');

    expect(patchBodies()).toEqual([{ display_order: 7 }]);
  });

  it('説明を空にしたら description: null を送る (説明を消す)', async () => {
    mockApi({ patch: () => jsonResponse(200, { data: PLAN }) });
    await renderPage();
    await typeInto(descriptionInput(), '');

    await click('保存する');

    expect(patchBodies()).toEqual([{ description: null }]);
  });

  it('変えた欄を元の値に戻したら、変えていないものとして送らない', async () => {
    mockApi({ patch: () => jsonResponse(200, { data: PLAN }) });
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');
    await typeInto(displayNameInput(), 'Pro');

    await click('保存する');

    expect(patchBodies()).toEqual([]);
    expect(text()).toContain('変更した項目がないので、保存していません');
  });

  it('何も変えずに保存したら送らず、その旨を出す。入力欄を変えたらその文は消える', async () => {
    const state = mockApi({ patch: () => jsonResponse(200, { data: PLAN }) });
    await renderPage();

    await click('保存する');

    expect(patchBodies()).toEqual([]);
    expect(state.gets).toBe(1);
    expect(text()).toContain('変更した項目がないので、保存していません');
    expect(text()).not.toContain('保存しました');

    await typeInto(displayNameInput(), 'Pro プラス');
    expect(text()).not.toContain('変更した項目がないので、保存していません');
  });

  it('保存のあとに読み直した値が新しい初めの値になり、次の保存は、そのあとに変えた欄だけを送る', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse(200, { data: PLAN });
      gets += 1;
      // 1 回目の保存のあとの読み直しでは、保存した表示名と、別の運営が変えた説明が入っている
      return jsonResponse(200, { data: gets === 1 ? PLAN : { ...PLAN, display_name: 'Pro プラス', description: '別の運営の説明' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');
    await click('保存する');
    expect(descriptionInput().value).toBe('別の運営の説明');

    await typeInto(displayOrderInput(), '9');
    await click('保存する');

    expect(patchBodies()).toEqual([{ display_name: 'Pro プラス' }, { display_order: 9 }]);
  });
});

describe('表示したあとの読み直しが 404 / 403 で断られたとき (#1917)', () => {
  it.each([
    [404, 'プランが見つかりません'],
    [403, '権限がありません'],
  ])('409 のあとの読み直しが %s なら、その理由を出し、「読み込み直せませんでした」と「再試行」は出さない', async (status, message) => {
    const state = mockApi({ patch: staleResponse, failGets: [2], failGetStatus: status });
    await renderPage();

    await click('再公開する');

    expect(state.gets).toBe(2);
    expect(notice()?.textContent).toContain(message);
    expect(notice()?.textContent).not.toContain('読み込み直せませんでした');
    expect(notice()?.textContent).not.toContain('読み込み直したので');
    expect(notice()?.querySelector('button')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('409 のあとの読み直しが 404 でも、入力欄の書きかけは残す (画面を消さない)', async () => {
    mockApi({ patch: staleResponse, failGets: [2], failGetStatus: 404 });
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');

    await click('保存する');

    expect(displayNameInput().value).toBe('Pro プラス');
    expect(notice()?.textContent).toContain('プランが見つかりません');
    expect(notice()?.textContent).not.toContain('再試行');
  });

  it('保存に成功したあとの読み直しが 404 なら、その理由を出し、「最新の内容を読み込めませんでした」と「再試行」は出さない', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse(200, { data: PLAN });
      gets += 1;
      if (gets === 2) return jsonResponse(404, GET_FAILURE_BODIES[404]);
      return jsonResponse(200, { data: PLAN });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');

    await click('保存する');

    expect(gets).toBe(2);
    expect(notice()?.textContent).toContain('プランが見つかりません');
    expect(notice()?.textContent).not.toContain('最新の内容を読み込めませんでした');
    expect(notice()?.querySelector('button')).toBeNull();
  });

  it('「再試行」の読み直しが 404 なら、「読み込み直せませんでした」を理由の文に変える', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse(200, { data: PLAN });
      gets += 1;
      if (gets === 2) return jsonResponse(500, GET_FAILURE_BODIES[500]);
      if (gets === 3) return jsonResponse(404, GET_FAILURE_BODIES[404]);
      return jsonResponse(200, { data: PLAN });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await typeInto(displayNameInput(), 'Pro プラス');
    await click('保存する');
    expect(notice()?.textContent).toContain('最新の内容を読み込めませんでした');

    await click('再試行');

    expect(gets).toBe(3);
    expect(notice()?.textContent).toContain('プランが見つかりません');
    expect(notice()?.querySelector('button')).toBeNull();
  });
});
