/**
 * #2080 U5 (10/29 の整合ゲート 1029a・1029b の候補・triage-1029b) のテスト
 *
 * 運営の家族・組織の強制譲渡 (/operator/membership/{families,orgs}/[id]/transfer) と強制解散 (/operator/membership/{families,orgs}/inactive) で:
 *   - 書き込みの fetch が reject (通信が切れた) すると、確認の枠にブラウザの英字の例外の文 (Failed to fetch) をそのまま出し、
 *     対象を読み直さなかった。サーバーが済ませてから応答が切れても、画面は前の状態のままだった。
 *     直したあとは「<操作>の応答を受け取れませんでした（通信エラー）」と出し、対象を読み直す。済んでいれば一覧へ戻す
 *     (強制譲渡: 選んだメンバーが譲渡先の候補から外れていれば済んでいる。強制解散: 対象が解散されずに一覧に残っていなければ済んでいる)。
 *     済んでいなければ・読み直せなければ、その事実に合う文を出す
 *   - 本文に message の無い失敗 (プロキシの 502 など) を「HTTP 502」と英字だけで出していた。直したあとは「<操作>に失敗しました (HTTP 502)」
 *   - 読み込み (候補・一覧) の失敗も同じく英字の文を出していた (同じ型)。直したあとは「<対象>を読み込めませんでした（通信エラー）」など
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID_2 = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID_2 = '44444444-4444-4444-8444-444444444444';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_B_ID = '66666666-6666-4666-8666-666666666666';

/** ブラウザの fetch の reject の英字の文 (画面に出てはいけない) */
const BROWSER_NETWORK_ERROR = 'Failed to fetch';

/** 画面の文 (画面と同じもの) */
const TRANSFER_NO_RESPONSE = '強制譲渡の応答を受け取れませんでした（通信エラー）';
const TRANSFER_NOT_DONE =
  '候補を読み込み直したところ、選んだメンバーはまだ譲渡先の候補にいて、譲渡されていません。必要ならもう一度実行してください';
const TRANSFER_RELOAD_FAILED =
  '候補も読み込めなかったため、譲渡が済んだか分かりません。「再試行」で候補を読み込み直して確かめるまで、もう一度は実行できません';
const DISSOLVE_NO_RESPONSE = '強制解散の応答を受け取れませんでした（通信エラー）';
const DISSOLVE_NOT_DONE = '一覧を読み込み直したところ、まだ解散されていません。必要ならもう一度実行してください';
const DISSOLVE_RELOAD_FAILED =
  '一覧も読み込めなかったため、解散が済んだか分かりません。「更新」で一覧を読み込み直して状態を確かめてから、必要ならもう一度操作してください';

const params = vi.hoisted(() => ({ id: '' }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => params,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: FamilyTransferPage } = await import('@/app/(operator)/operator/membership/families/[id]/transfer/page');
const { default: OrgTransferPage } = await import('@/app/(operator)/operator/membership/orgs/[id]/transfer/page');
const { default: InactiveFamiliesPage } = await import('@/app/(operator)/operator/membership/families/inactive/page');
const { default: InactiveOrgsPage } = await import('@/app/(operator)/operator/membership/orgs/inactive/page');
const { default: ForceActionConfirmModal } = await import('@/components/operator/membership/ForceActionConfirmModal');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch の応答の決め方。関数なら呼ぶたびに決める (読み直しで中身を変えるため)。reject を返すと通信の失敗の筋書き */
type Responder = () => Response | Promise<Response>;

let container: HTMLDivElement;
let root: Root;
/** `<METHOD> <URL>` -> 応答 */
let routes: Map<string, Responder>;
let calls: string[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 本文が JSON でない失敗 (プロキシの 502 など) */
function plain(status: number): Response {
  return new Response('<html>Bad Gateway</html>', { status, headers: { 'Content-Type': 'text/html' } });
}

const networkFailure: Responder = () => Promise.reject(new TypeError(BROWSER_NETWORK_ERROR));

/** 呼ぶたびに順に返す (最後の応答は繰り返す) */
function sequence(...responders: Responder[]): Responder {
  let i = 0;
  return () => {
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder();
  };
}

function route(method: string, url: string, responder: Responder) {
  routes.set(`${method} ${url}`, responder);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(field: HTMLTextAreaElement | null, value: string) {
  expect(field, 'textarea が見つからない').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = () => container.textContent ?? '';
const countCalls = (key: string) => calls.filter((c) => c === key).length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  routes = new Map();
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    calls.push(key);
    const responder = routes.get(key);
    if (!responder) throw new Error(`テストに無い fetch: ${key}`);
    return responder();
  });
  router.push.mockReset();
  router.refresh.mockReset();
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  process.off('unhandledRejection', onUnhandled);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 強制譲渡 (家族・組織)
// ─────────────────────────────────────────────────────────────────────────────

type TransferCase = {
  name: string;
  scopeId: string;
  page: () => React.ReactElement;
  candidatesUrl: string;
  transferUrl: string;
  listPath: string;
  candidateA: Record<string, unknown>;
  candidateB: Record<string, unknown>;
  /** 譲渡先がすでに今の代表者 / オーナーのときに route が返す 409 の code (#2086 V1) */
  alreadyCode: string;
};

const TRANSFER_CASES: TransferCase[] = [
  {
    name: '家族の代表者の強制譲渡',
    scopeId: FAMILY_ID,
    page: () => createElement(FamilyTransferPage),
    candidatesUrl: `/api/operator/membership/family/${FAMILY_ID}/candidates`,
    transferUrl: `/api/operator/membership/family/${FAMILY_ID}/transfer`,
    listPath: '/operator/membership/families/inactive',
    candidateA: { id: MEMBER_A_ID, nickname: 'Aさん', role: 'adult', last_login_at: null, email: 'a@example.com' },
    candidateB: { id: MEMBER_B_ID, nickname: 'Bさん', role: 'adult', last_login_at: null, email: 'b@example.com' },
    alreadyCode: 'ALREADY_REPRESENTATIVE',
  },
  {
    name: '組織のオーナーの強制譲渡',
    scopeId: ORG_ID,
    page: () => createElement(OrgTransferPage),
    candidatesUrl: `/api/operator/membership/org/${ORG_ID}/candidates`,
    transferUrl: `/api/operator/membership/org/${ORG_ID}/transfer`,
    listPath: '/operator/membership/orgs/inactive',
    candidateA: { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', last_login_at: null, email: 'a@example.com' },
    candidateB: { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'admin', last_login_at: null, email: 'b@example.com' },
    alreadyCode: 'ALREADY_OWNER',
  },
];

describe.each(TRANSFER_CASES)('#2080 U5 $name: 通信が切れたら候補を読み直し、英字の文を出さない', (c) => {
  /** 候補 A を選び、理由を入れて確認の枠の「実行する」まで押す */
  async function confirmTransferToA() {
    const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${MEMBER_A_ID}"]`);
    expect(radio, '候補 A のラジオが無い').not.toBeNull();
    await click(radio!, '候補 A のラジオ');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('強制譲渡を実行'), '「強制譲渡を実行」');
    await click(findButton('実行する'), '確認の枠の「実行する」');
  }

  beforeEach(() => {
    params.id = c.scopeId;
  });

  it('譲渡の通信が切れ、読み直した候補から選んだメンバーが外れていた (譲渡が済んでいた) ら、一覧へ戻す', async () => {
    route('GET', c.candidatesUrl, sequence(() => json(200, { data: [c.candidateA, c.candidateB] }), () => json(200, { data: [c.candidateB] })));
    route('POST', c.transferUrl, networkFailure);
    await renderElement(c.page());

    await confirmTransferToA();

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(2);
    expect(router.push).toHaveBeenCalledWith(c.listPath);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('譲渡の通信が切れ、読み直しても選んだメンバーがまだ候補にいたら、一覧へ戻さず、応答を受け取れなかった文と済んでいない文を出す', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, networkFailure);
    await renderElement(c.page());

    await confirmTransferToA();

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(2);
    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${TRANSFER_NO_RESPONSE}。${TRANSFER_NOT_DONE}`);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    // 確認の枠は開いたまま (もう一度実行できる)
    expect(findButton('実行する')).toBeDefined();
  });

  it('譲渡の通信が切れ、候補の読み直しにも失敗したら、済んだか分からない文を出し、読み直せるまで押し直せなくする (英字の文を出さない。#2086 V1)', async () => {
    route('GET', c.candidatesUrl, sequence(() => json(200, { data: [c.candidateA, c.candidateB] }), networkFailure));
    route('POST', c.transferUrl, networkFailure);
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${TRANSFER_NO_RESPONSE}。${TRANSFER_RELOAD_FAILED}`);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    // 済んだか分からないまま同じ譲渡を押し直せない (確認の枠を閉じ、「強制譲渡を実行」も出さない)
    expect(findButton('実行する')).toBeUndefined();
    expect(findButton('強制譲渡を実行')).toBeUndefined();
    expect(findButton('再試行')).toBeDefined();
    expect(countCalls(`POST ${c.transferUrl}`)).toBe(1);
  });

  it('本文に文の無い 502 / 503 / 504 以外の失敗 (500) は「強制譲渡に失敗しました (HTTP 500)」と出し、読み直さない', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () => plain(500));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain('強制譲渡に失敗しました (HTTP 500)');
    // route の応答を受け取れている失敗では読み直さない
    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(1);
  });

  it('失敗の応答の本文に API の文があれば、その文を出す', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () => json(400, { error: { code: 'TARGET_NOT_IN_FAMILY', message: '譲渡先のユーザーは所属していません' } }));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(text()).toContain('譲渡先のユーザーは所属していません');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('成功したら一覧へ戻す (これまでどおり)', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () => json(200, { data: {} }));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).toHaveBeenCalledWith(c.listPath);
    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(1);
  });

  it('候補の読み込みの通信が切れたら、英字の文でなく「譲渡の候補を読み込めませんでした（通信エラー）」と出す', async () => {
    route('GET', c.candidatesUrl, networkFailure);
    await renderElement(c.page());

    expect(text()).toContain('譲渡の候補を読み込めませんでした（通信エラー）');
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
  });

  it('候補の読み込みが本文に文の無い失敗 (502) なら「譲渡の候補を読み込めませんでした (HTTP 502)」と出す', async () => {
    route('GET', c.candidatesUrl, () => plain(502));
    await renderElement(c.page());

    expect(text()).toContain('譲渡の候補を読み込めませんでした (HTTP 502)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 強制解散 (家族・組織の一覧)
// ─────────────────────────────────────────────────────────────────────────────

type DissolveCase = {
  name: string;
  page: () => React.ReactElement;
  listUrl: string;
  dissolveUrl: string;
  listSubject: string;
  rowA: Record<string, unknown>;
  rowB: Record<string, unknown>;
  /** 解散が済んだあとの一覧 (組織の一覧は解散済みを dissolved: true で返すことがある) */
  afterDissolved: Record<string, unknown>[];
};

const DISSOLVE_CASES: DissolveCase[] = [
  {
    name: '家族グループの強制解散',
    page: () => createElement(InactiveFamiliesPage),
    listUrl: '/api/operator/membership/families/inactive',
    dissolveUrl: `/api/operator/membership/family/${FAMILY_ID}/dissolve`,
    listSubject: '家族グループの一覧',
    rowA: { family_id: FAMILY_ID, family_name: '山田家', representative_user_id: MEMBER_A_ID, representative_email: 'a@example.com', member_count: 3 },
    rowB: { family_id: FAMILY_ID_2, family_name: '鈴木家', representative_user_id: MEMBER_B_ID, representative_email: 'b@example.com', member_count: 2 },
    afterDissolved: [
      { family_id: FAMILY_ID_2, family_name: '鈴木家', representative_user_id: MEMBER_B_ID, representative_email: 'b@example.com', member_count: 2 },
    ],
  },
  {
    name: '組織の強制解散',
    page: () => createElement(InactiveOrgsPage),
    listUrl: '/api/operator/membership/orgs/inactive',
    dissolveUrl: `/api/operator/membership/org/${ORG_ID}/dissolve`,
    listSubject: '組織の一覧',
    rowA: { organization_id: ORG_ID, organization_name: '山田商店', owner_user_id: MEMBER_A_ID, owner_email: 'a@example.com', owner_last_sign_in: null, member_count: 3, dissolved: false },
    rowB: { organization_id: ORG_ID_2, organization_name: '鈴木商店', owner_user_id: MEMBER_B_ID, owner_email: 'b@example.com', owner_last_sign_in: null, member_count: 2, dissolved: false },
    afterDissolved: [
      { organization_id: ORG_ID, organization_name: '山田商店', owner_user_id: MEMBER_A_ID, owner_email: 'a@example.com', owner_last_sign_in: null, member_count: 3, dissolved: true },
      { organization_id: ORG_ID_2, organization_name: '鈴木商店', owner_user_id: MEMBER_B_ID, owner_email: 'b@example.com', owner_last_sign_in: null, member_count: 2, dissolved: false },
    ],
  },
];

describe.each(DISSOLVE_CASES)('#2080 U5 $name: 通信が切れたら一覧を読み直し、英字の文を出さない', (c) => {
  const nameOf = (row: Record<string, unknown>) => String(row.family_name ?? row.organization_name);

  /** 1 行目 (rowA) の「解散」を押し、理由を入れて確認の枠の「実行する」まで押す */
  async function confirmDissolveA() {
    const rowA = Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes(nameOf(c.rowA)));
    expect(rowA, '対象の行が無い').toBeDefined();
    await click(Array.from(rowA!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '解散'), '行の「解散」');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('次へ'), '「次へ」');
    await click(findButton('実行する'), '確認の枠の「実行する」');
  }

  it('解散の通信が切れ、読み直した一覧で対象が解散されていたら、確認の枠を閉じて読み直した一覧を出す', async () => {
    route('GET', c.listUrl, sequence(() => json(200, { data: [c.rowA, c.rowB] }), () => json(200, { data: c.afterDissolved })));
    route('POST', c.dissolveUrl, networkFailure);
    await renderElement(c.page());

    await confirmDissolveA();

    expect(countCalls(`GET ${c.listUrl}`)).toBe(2);
    expect(findButton('実行する')).toBeUndefined();
    expect(container.querySelector('tbody')?.textContent ?? '').not.toContain(nameOf(c.rowA));
    expect(container.querySelector('tbody')?.textContent ?? '').toContain(nameOf(c.rowB));
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    expect(text()).not.toContain(DISSOLVE_NOT_DONE);
    expect(unhandled).toEqual([]);
  });

  it('解散の通信が切れ、読み直しても対象がまだ一覧にあったら、応答を受け取れなかった文と済んでいない文を出す', async () => {
    route('GET', c.listUrl, () => json(200, { data: [c.rowA, c.rowB] }));
    route('POST', c.dissolveUrl, networkFailure);
    await renderElement(c.page());

    await confirmDissolveA();

    expect(countCalls(`GET ${c.listUrl}`)).toBe(2);
    expect(text()).toContain(`${DISSOLVE_NO_RESPONSE}。${DISSOLVE_NOT_DONE}`);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    expect(findButton('実行する')).toBeDefined();
  });

  it('解散の通信が切れ、一覧の読み直しにも失敗したら、済んだか分からない文を出し、読み直せるまで押し直せなくする (英字の文を出さない。#2086 V1)', async () => {
    route('GET', c.listUrl, sequence(() => json(200, { data: [c.rowA, c.rowB] }), networkFailure));
    route('POST', c.dissolveUrl, networkFailure);
    await renderElement(c.page());

    await confirmDissolveA();

    expect(text()).toContain(`${DISSOLVE_NO_RESPONSE}。${DISSOLVE_RELOAD_FAILED}`);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
    // 確認の枠を閉じ、一覧 (行の「解散」) も出さない。「更新」で読み直せるまで止める
    expect(findButton('実行する')).toBeUndefined();
    expect(container.querySelector('tbody')).toBeNull();
    expect(countCalls(`POST ${c.dissolveUrl}`)).toBe(1);
  });

  it('本文に文の無い 502 / 503 / 504 以外の失敗 (500) は「強制解散に失敗しました (HTTP 500)」と出し、読み直さない', async () => {
    route('GET', c.listUrl, () => json(200, { data: [c.rowA, c.rowB] }));
    route('POST', c.dissolveUrl, () => plain(500));
    await renderElement(c.page());

    await confirmDissolveA();

    expect(text()).toContain('強制解散に失敗しました (HTTP 500)');
    expect(countCalls(`GET ${c.listUrl}`)).toBe(1);
  });

  it('成功したら確認の枠を閉じて一覧を読み直す (これまでどおり)', async () => {
    route('GET', c.listUrl, sequence(() => json(200, { data: [c.rowA, c.rowB] }), () => json(200, { data: c.afterDissolved })));
    route('POST', c.dissolveUrl, () => json(200, { data: {} }));
    await renderElement(c.page());

    await confirmDissolveA();

    expect(countCalls(`GET ${c.listUrl}`)).toBe(2);
    expect(findButton('実行する')).toBeUndefined();
    expect(container.querySelector('tbody')?.textContent ?? '').not.toContain(nameOf(c.rowA));
  });

  it('一覧の読み込みの通信が切れたら、英字の文でなく「<一覧>を読み込めませんでした（通信エラー）」と出す', async () => {
    route('GET', c.listUrl, networkFailure);
    await renderElement(c.page());

    expect(text()).toContain(`${c.listSubject}を読み込めませんでした（通信エラー）`);
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
  });

  it('一覧の読み込みが本文に文の無い失敗 (502) なら「<一覧>を読み込めませんでした (HTTP 502)」と出す', async () => {
    route('GET', c.listUrl, () => plain(502));
    await renderElement(c.page());

    expect(text()).toContain(`${c.listSubject}を読み込めませんでした (HTTP 502)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 確認の枠
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U5 確認の枠 (ForceActionConfirmModal): 想定外の例外の英字の文を出さない', () => {
  it('onConfirm がブラウザの例外 (TypeError: Failed to fetch) を投げたら、固定の日本語の文を出す', async () => {
    const onConfirm = vi.fn(() => Promise.reject(new TypeError(BROWSER_NETWORK_ERROR)));
    await renderElement(
      createElement(ForceActionConfirmModal, {
        scope: 'family',
        scopeName: '山田家',
        action: 'dissolve',
        reason: '理由',
        onConfirm,
        onCancel: () => undefined,
      }),
    );

    await click(findButton('実行する'), '「実行する」');

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(text()).toContain('強制解散に失敗しました');
    expect(text()).not.toContain(BROWSER_NETWORK_ERROR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2086 V1: 本文に API の文が無い 502 / 503 / 504 は応答を受け取れなかったものとして読み直す・
// 済んだか分からないあいだは押し直させない・譲渡先がすでに代表者 / オーナーの 409 は済んだものとして一覧へ戻す
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 譲渡の route は RPC の commit のあとに監査と全メンバーへの通知メールを待つので、その間にプロキシが 504 を返すと
 * 譲渡は済んでいるのに画面は失敗と見ていた。そこで「実行する」を押し直すと、同じ人への譲渡がもう一度通り、
 * 監査と通知メールが二重になった (#2086 V1)
 */
const GATEWAY_STATUSES = [502, 503, 504] as const;

const transferNoResponseHead = (status: number) => `強制譲渡の応答を受け取れませんでした (HTTP ${status})`;
const dissolveNoResponseHead = (status: number) => `強制解散の応答を受け取れませんでした (HTTP ${status})`;

describe.each(TRANSFER_CASES)('#2086 V1 $name: 本文の無い 502 / 503 / 504 のあとの押し直しで譲渡を二重にしない', (c) => {
  async function confirmTransferToA() {
    const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${MEMBER_A_ID}"]`);
    expect(radio, '候補 A のラジオが無い').not.toBeNull();
    await click(radio!, '候補 A のラジオ');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('強制譲渡を実行'), '「強制譲渡を実行」');
    await click(findButton('実行する'), '確認の枠の「実行する」');
  }

  beforeEach(() => {
    params.id = c.scopeId;
  });

  it.each(GATEWAY_STATUSES)('本文の無い %i で、読み直した候補から選んだメンバーが外れていた (譲渡が済んでいた) ら、失敗と出さずに一覧へ戻す', async (status) => {
    route('GET', c.candidatesUrl, sequence(() => json(200, { data: [c.candidateA, c.candidateB] }), () => json(200, { data: [c.candidateB] })));
    route('POST', c.transferUrl, () => plain(status));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(2);
    expect(router.push).toHaveBeenCalledWith(c.listPath);
    expect(text()).not.toContain(`強制譲渡に失敗しました (HTTP ${status})`);
    expect(unhandled).toEqual([]);
  });

  it.each(GATEWAY_STATUSES)('本文の無い %i で、読み直しても選んだメンバーがまだ候補にいたら、「応答を受け取れませんでした (HTTP <番号>)」と済んでいない文を出し、押し直せる', async (status) => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () => plain(status));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(2);
    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${transferNoResponseHead(status)}。${TRANSFER_NOT_DONE}`);
    expect(findButton('実行する')).toBeDefined();
  });

  it('本文の無い 504 で、候補の読み直しにも失敗したら、確認の枠を閉じて押し直せなくし、「再試行」で読み直して済んでいれば一覧へ戻す', async () => {
    route(
      'GET',
      c.candidatesUrl,
      sequence(
        () => json(200, { data: [c.candidateA, c.candidateB] }),
        networkFailure,
        () => json(200, { data: [c.candidateB] }),
      ),
    );
    route('POST', c.transferUrl, () => plain(504));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${transferNoResponseHead(504)}。${TRANSFER_RELOAD_FAILED}`);
    expect(findButton('実行する')).toBeUndefined();
    expect(findButton('強制譲渡を実行')).toBeUndefined();

    await click(findButton('再試行'), '「再試行」');

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(3);
    expect(router.push).toHaveBeenCalledWith(c.listPath);
    expect(countCalls(`POST ${c.transferUrl}`)).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('「再試行」で読み直して選んだメンバーがまだ候補にいたら、済んでいない文を出して候補と「強制譲渡を実行」を戻す (選んだメンバーはそのまま)', async () => {
    route(
      'GET',
      c.candidatesUrl,
      sequence(
        () => json(200, { data: [c.candidateA, c.candidateB] }),
        networkFailure,
        () => json(200, { data: [c.candidateA, c.candidateB] }),
      ),
    );
    route('POST', c.transferUrl, () => plain(504));
    await renderElement(c.page());

    await confirmTransferToA();
    await click(findButton('再試行'), '「再試行」');

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${transferNoResponseHead(504)}。${TRANSFER_NOT_DONE}`);
    expect(text()).not.toContain(TRANSFER_RELOAD_FAILED);
    expect(findButton('強制譲渡を実行')).toBeDefined();
    expect(container.querySelector<HTMLInputElement>(`input[type="radio"][value="${MEMBER_A_ID}"]`)?.checked).toBe(true);
  });

  it('「再試行」の読み直しにも失敗したら、押し直せないまま済んだか分からない文を出し続ける', async () => {
    route('GET', c.candidatesUrl, sequence(() => json(200, { data: [c.candidateA, c.candidateB] }), networkFailure));
    route('POST', c.transferUrl, () => plain(504));
    await renderElement(c.page());

    await confirmTransferToA();
    await click(findButton('再試行'), '「再試行」');

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(3);
    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(`${transferNoResponseHead(504)}。${TRANSFER_RELOAD_FAILED}`);
    expect(findButton('強制譲渡を実行')).toBeUndefined();
    expect(findButton('実行する')).toBeUndefined();
    expect(findButton('再試行')).toBeDefined();
  });

  it('譲渡先がすでに今の代表者 / オーナーの 409 は、済んでいたものとして失敗と出さずに一覧へ戻す (読み直さない)', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () =>
      json(409, { error: { code: c.alreadyCode, message: 'この人はすでに代表者です。一覧で今の状態を確かめてください' } }),
    );
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).toHaveBeenCalledWith(c.listPath);
    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(1);
  });

  it('ほかの code の 409 は済んだものとせず、本文の文を出す', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () =>
      json(409, { error: { code: 'REPRESENTATIVE_ACCOUNT_DELETING', message: '譲渡先のユーザーは退会の手続き中です' } }),
    );
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain('譲渡先のユーザーは退会の手続き中です');
  });

  it('502 でも本文に API の文があれば (route が返した応答)、その文を出し、読み直さない', async () => {
    route('GET', c.candidatesUrl, () => json(200, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, () => json(502, { error: { code: 'UPSTREAM', message: '外部の処理に失敗しました' } }));
    await renderElement(c.page());

    await confirmTransferToA();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain('外部の処理に失敗しました');
    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(1);
  });
});

describe.each(DISSOLVE_CASES)('#2086 V1 $name: 本文の無い 502 / 503 / 504 は一覧を読み直し、済んだか分からないあいだは押し直させない', (c) => {
  const nameOf = (row: Record<string, unknown>) => String(row.family_name ?? row.organization_name);

  async function confirmDissolveA() {
    const rowA = Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes(nameOf(c.rowA)));
    expect(rowA, '対象の行が無い').toBeDefined();
    await click(Array.from(rowA!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '解散'), '行の「解散」');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('次へ'), '「次へ」');
    await click(findButton('実行する'), '確認の枠の「実行する」');
  }

  it.each(GATEWAY_STATUSES)('本文の無い %i で、読み直した一覧で対象が解散されていたら、失敗と出さずに確認の枠を閉じる', async (status) => {
    route('GET', c.listUrl, sequence(() => json(200, { data: [c.rowA, c.rowB] }), () => json(200, { data: c.afterDissolved })));
    route('POST', c.dissolveUrl, () => plain(status));
    await renderElement(c.page());

    await confirmDissolveA();

    expect(countCalls(`GET ${c.listUrl}`)).toBe(2);
    expect(findButton('実行する')).toBeUndefined();
    expect(text()).not.toContain(`強制解散に失敗しました (HTTP ${status})`);
    expect(unhandled).toEqual([]);
  });

  it.each(GATEWAY_STATUSES)('本文の無い %i で、読み直しても対象がまだ一覧にあったら、「応答を受け取れませんでした (HTTP <番号>)」と済んでいない文を出す', async (status) => {
    route('GET', c.listUrl, () => json(200, { data: [c.rowA, c.rowB] }));
    route('POST', c.dissolveUrl, () => plain(status));
    await renderElement(c.page());

    await confirmDissolveA();

    expect(countCalls(`GET ${c.listUrl}`)).toBe(2);
    expect(text()).toContain(`${dissolveNoResponseHead(status)}。${DISSOLVE_NOT_DONE}`);
    expect(findButton('実行する')).toBeDefined();
  });

  it('本文の無い 504 で、一覧の読み直しにも失敗したら、確認の枠を閉じて一覧を出さず、「更新」で読み直せたら一覧を出す', async () => {
    route(
      'GET',
      c.listUrl,
      sequence(() => json(200, { data: [c.rowA, c.rowB] }), networkFailure, () => json(200, { data: c.afterDissolved })),
    );
    route('POST', c.dissolveUrl, () => plain(504));
    await renderElement(c.page());

    await confirmDissolveA();

    expect(text()).toContain(`${dissolveNoResponseHead(504)}。${DISSOLVE_RELOAD_FAILED}`);
    expect(findButton('実行する')).toBeUndefined();
    expect(container.querySelector('tbody')).toBeNull();

    await click(findButton('更新'), '「更新」');

    expect(countCalls(`GET ${c.listUrl}`)).toBe(3);
    expect(text()).not.toContain(DISSOLVE_RELOAD_FAILED);
    expect(container.querySelector('tbody')?.textContent ?? '').toContain(nameOf(c.rowB));
    expect(countCalls(`POST ${c.dissolveUrl}`)).toBe(1);
  });
});
