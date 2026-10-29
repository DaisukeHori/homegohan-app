/**
 * #2059 (10/26 の整合ゲート 1026e・1026f の候補) 組織の画面の、除名・脱退の通信エラーと、「再試行」と書き込みの重なりのテスト
 *
 *   - Q2: 組織のメンバーの画面で、除名・脱退の通信 (fetch) が失敗 (reject) すると、何も表示されなかった
 *     (try / finally だけで catch が無く、alert を通らずに finally へ進み、onClick の promise が reject のまま終わる)。
 *     直したあとは、通信エラーの文を alert で出す
 *   - Q3: 組織のチャレンジ・部署・招待の画面で、一覧を読み込めなかった状態 (「再試行」が出ている) で作成のフォームを送り、
 *     その応答を待つ間に「再試行」を押すと、再試行の GET が作成より前の一覧を読み、作成のあとの読み直しより後に届いたとき、
 *     その古い一覧で表示が上書きされ、作ったものが表示から消えた (もう一度作って重複させるおそれ)。
 *     直したあとは、書き込み (とそのあとの読み直し) の応答を待つ間は「再試行」を止め、押されても送らない
 *     (#2050 の writeInFlightRef / isWriting と同じ形)。同じ形のメンバーの画面 (脱退の応答を待つ間) も同じ
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgMemberListKeyOf, orgMemberListResponse } from './helpers/org-member-list-fetch';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';

/** 脱退の通信が失敗したときに出す理由 (画面の文と同じもの) */
const NETWORK_FAILURE_REASON = '通信エラーが発生しました。通信状況を確認して、もう一度お試しください';
/** 除名の通信が失敗し、一覧を読み直せたときに出す文 (#2080 U4。除名できなかったとは言わない) */
const REMOVE_NO_RESPONSE_RELOADED =
  '除名の応答を受け取れませんでした（通信エラー）。一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください';

const supabaseState = vi.hoisted(() => ({
  /** メンバーの画面の自分のプロフィールの Supabase の問い合わせの結果 (テストごとに差し替える) */
  profile: { data: null as unknown, error: null as unknown },
  /** メンバーの一覧の API (GET /api/org/members。#2073 S4) の結果。以前の問い合わせと同じ { data, error } で書く
   *  (tests/helpers/org-member-list-fetch.ts が API の応答に直す) */
  members: { data: null as unknown, error: null as unknown },
  /** メンバーの一覧の API の GET を送った回数 */
  membersQueryCount: 0,
}));

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// メンバーの画面は自分のプロフィールを Supabase の問い合わせで読む (一覧は API。下の mockFetch)
vi.mock('@/lib/supabase/client', () => {
  const builder = () => {
    const query = {
      select: () => query,
      eq: () => query,
      single: () => Promise.resolve(supabaseState.profile),
    };
    return query;
  };
  return {
    createClient: () => ({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
      from: () => builder(),
    }),
  };
});

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');
const { default: OrgChallengesAdminPage } = await import('@/app/(org)/org/challenges/page');
const { default: MembersPage } = await import('@/app/(org)/org/members/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** あとで返す応答 (応答を待つ間の画面を確かめるため) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

type Handler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    // メンバーの一覧の API の GET は supabaseState.members から返す (#2073 S4)
    const listKey = orgMemberListKeyOf(input, init);
    if (listKey !== null) {
      supabaseState.membersQueryCount += 1;
      return orgMemberListResponse(listKey, supabaseState.members);
    }
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(method, url, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

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

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(element, '入力欄が見つからない').not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** フォームを送る (必須の欄の検査は本題ではないので、submit の事件を直接送る) */
async function submitForm() {
  const form = container.querySelector('form');
  expect(form, 'フォームが見つからない').not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  router.push.mockReset();
  supabaseState.profile = { data: null, error: null };
  supabaseState.members = { data: null, error: null };
  supabaseState.membersQueryCount = 0;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Q3: 「再試行」と作成の重なり (チャレンジ・部署・招待)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一覧の API の模型。サーバーの一覧 (作成で 1 件増える) を持ち、
 *   - 1 本目の GET (画面を開いたとき) は 500 で断る (「再試行」を出すため)
 *   - 作成の POST の応答は postGate まで返さない
 *   - POST を受け取ってから応答を返すまでに届いた GET は、受け取った時点の一覧 (作成の前の一覧) で答え、
 *     その応答は作成のあとの読み直しより後 (releaseHeldGets) まで返さない (古い一覧が後に届く順)
 */
function mockListApi<T>(options: {
  path: string;
  initial: T[];
  /** GET の応答の本文 */
  listBody: (items: T[]) => unknown;
  /** POST の本文から、作られる 1 件 */
  created: (body: unknown) => T;
  postGate: Promise<void>;
}) {
  let server = [...options.initial];
  let getCount = 0;
  let postPending = false;
  const heldGets: Array<() => void> = [];
  mockFetch((method, url, body) => {
    if (url.pathname !== options.path) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      getCount += 1;
      if (getCount === 1) return jsonResponse(500, { error: { message: 'internal' } });
      const response = jsonResponse(200, options.listBody([...server]));
      if (postPending) {
        const held = deferred<Response>();
        heldGets.push(() => held.resolve(response));
        return held.promise;
      }
      return response;
    }
    if (method === 'POST') {
      postPending = true;
      return options.postGate.then(() => {
        server = [...server, options.created(body)];
        postPending = false;
        return jsonResponse(201, {});
      });
    }
    throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
  });
  return {
    serverItems: () => server,
    releaseHeldGets: () => heldGets.splice(0).forEach((release) => release()),
  };
}

/**
 * 共通の筋書き: 読み込みに失敗した画面で作成を送り、その応答を待つ間に「再試行」を押す。
 * 「再試行」は止まっていて送らず、作成のあとの読み直しの一覧 (作ったものを含む) が残る
 */
async function expectRetryWaitsForWrite(args: {
  path: string;
  loadErrorTestId: string;
  openForm: () => Promise<void>;
  submitLabel: string;
  shownNames: () => Array<string | null>;
  createdName: string;
  api: { releaseHeldGets: () => void };
  post: { resolve: (value: void) => void };
}) {
  expect(container.querySelector(`[data-testid="${args.loadErrorTestId}"]`), '読み込みの失敗の文').not.toBeNull();
  await args.openForm();
  await submitForm();
  expect(callsOf('POST', args.path)).toHaveLength(1);

  // 作成の応答を待つ間は「再試行」を止め、押されても一覧を読み直さない
  const retry = findButton('再試行');
  expect(retry, '「再試行」ボタン').toBeDefined();
  expect(retry!.disabled).toBe(true);
  await click(retry, '「再試行」ボタン');
  expect(callsOf('GET', args.path)).toHaveLength(1);
  // 作成のボタン (送信中の表示) もまだ止まっている
  expect(findButton(args.submitLabel)).toBeUndefined();

  await act(async () => {
    args.post.resolve();
  });
  await settle();
  // (直す前は、ここで遅れていた再試行の古い一覧が届き、作ったものが表示から消えた)
  await act(async () => {
    args.api.releaseHeldGets();
  });
  await settle();

  expect(callsOf('GET', args.path)).toHaveLength(2);
  expect(container.querySelector(`[data-testid="${args.loadErrorTestId}"]`)).toBeNull();
  expect(args.shownNames()).toContain(args.createdName);
}

describe('#2059 Q3 組織のチャレンジ: 作成の応答を待つ間は「再試行」を止める', () => {
  const CHALLENGES_PATH = '/api/org/challenges';
  function challenge(id: string, title: string) {
    return {
      id,
      title,
      description: null,
      challengeType: 'breakfast_rate',
      targetValue: 80,
      targetUnit: '%',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      rewardDescription: null,
      status: 'draft',
      participantCount: null,
      aggregate: { minParticipants: 10, visible: false, averageValue: null },
      createdAt: '2026-09-01T00:00:00Z',
    };
  }

  it('読み込みに失敗した画面で作成を送り、応答を待つ間に「再試行」を押しても送らず、作ったチャレンジが表示から消えない', async () => {
    const post = deferred<void>();
    const api = mockListApi({
      path: CHALLENGES_PATH,
      initial: [challenge('c-1', '朝食チャレンジ')],
      listBody: (challenges) => ({ challenges }),
      created: (body) => challenge('c-new', (body as { title: string }).title),
      postGate: post.promise,
    });
    await renderElement(createElement(OrgChallengesAdminPage));

    await expectRetryWaitsForWrite({
      path: CHALLENGES_PATH,
      loadErrorTestId: 'challenge-load-error',
      openForm: async () => {
        await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');
        await typeInto(container.querySelector<HTMLInputElement>('form input[type="text"]'), '野菜チャレンジ');
      },
      submitLabel: '作成',
      shownNames: () => Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
      createdName: '野菜チャレンジ',
      api,
      post,
    });
    expect(Array.from(container.querySelectorAll('h3')).map((h) => h.textContent)).toEqual(['朝食チャレンジ', '野菜チャレンジ']);
  });
});

describe('#2059 Q3 組織の部署: 追加の応答を待つ間は「再試行」を止める', () => {
  const DEPARTMENTS_PATH = '/api/org/departments';
  function department(id: string, name: string) {
    return { id, name, parentId: null, managerId: null, displayOrder: 0, memberCount: 0, createdAt: '2026-10-01T03:00:00.000Z' };
  }

  it('読み込みに失敗した画面で追加を送り、応答を待つ間に「再試行」を押しても送らず、追加した部署が表示から消えない', async () => {
    const post = deferred<void>();
    const api = mockListApi({
      path: DEPARTMENTS_PATH,
      initial: [department('dept-1', '営業部')],
      listBody: (departments) => ({ departments }),
      created: (body) => department('dept-new', (body as { name: string }).name),
      postGate: post.promise,
    });
    await renderElement(createElement(OrgDepartmentsPage));

    await expectRetryWaitsForWrite({
      path: DEPARTMENTS_PATH,
      loadErrorTestId: 'department-load-error',
      openForm: async () => {
        await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
        await typeInto(container.querySelector<HTMLInputElement>('form input'), '開発部');
      },
      submitLabel: '追加',
      shownNames: () => Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
      createdName: '開発部',
      api,
      post,
    });
    expect(Array.from(container.querySelectorAll('h3')).map((h) => h.textContent)).toEqual(['営業部', '開発部']);
  });
});

describe('#2059 Q3 組織の招待: 招待の送信の応答を待つ間は「再試行」を止める', () => {
  const INVITES_PATH = '/api/org/invites';
  function invite(id: string, email: string) {
    return { id, email, role: 'member', token: `tok-${id}`, status: 'pending', isExpired: false, expiresAt: '2099-01-01T00:00:00.000Z' };
  }
  const shownEmails = () => Array.from(container.querySelectorAll('p.font-medium')).map((p) => p.textContent);

  it('読み込みに失敗した画面で招待を送り、応答を待つ間に「再試行」を押しても送らず、送った招待が履歴から消えない', async () => {
    const post = deferred<void>();
    const api = mockListApi({
      path: INVITES_PATH,
      initial: [invite('inv-1', 'invitee@example.com')],
      listBody: (invites) => ({ invites }),
      created: (body) => invite('inv-new', (body as { email: string }).email),
      postGate: post.promise,
    });
    await renderElement(createElement(OrgInvitesPage));

    await expectRetryWaitsForWrite({
      path: INVITES_PATH,
      loadErrorTestId: 'invite-load-error',
      openForm: async () => {
        await click(findButton('+ 新しいメンバーを招待'), '「+ 新しいメンバーを招待」ボタン');
        await typeInto(container.querySelector<HTMLInputElement>('input[type="email"]'), 'new@example.com');
      },
      submitLabel: '招待を送信',
      shownNames: shownEmails,
      createdName: 'new@example.com',
      api,
      post,
    });
    expect(shownEmails()).toEqual(['invitee@example.com', 'new@example.com']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q2: メンバーの除名・脱退の通信エラー / Q3 と同じ形: 脱退の応答を待つ間の「再試行」
// ─────────────────────────────────────────────────────────────────────────────

describe('#2059 Q2 組織のメンバー: 除名・脱退の通信が失敗したら、失敗の文を出す', () => {
  function membersOf(role: 'owner' | 'member') {
    return [
      { id: USER_ID, nickname: 'わたし', org_role: role, joined_org_at: '2026-10-01T03:00:00.000Z' },
      { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' },
    ];
  }

  it('除名の通信が失敗 (fetch が reject) したら、応答を受け取れなかった文を出し、ボタンを戻す (#2080 U4: 「除名失敗」とは言わない)', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    supabaseState.profile = { data: { org_role: 'owner', organization_id: 'org-1' }, error: null };
    supabaseState.members = { data: membersOf('owner'), error: null };
    await renderElement(createElement(MembersPage));

    await click(findButton('除名'), 'Aさんの「除名」ボタン');

    expect(callsOf('POST', `/api/org/members/${MEMBER_A_ID}/remove`)).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(REMOVE_NO_RESPONSE_RELOADED);
    // 除名できたかどうかは分からないので一覧を読み直す (#2064 R5)。サーバーの一覧に Aさんが残っているので、Aさんの「除名」はもう一度押せる
    expect(supabaseState.membersQueryCount).toBe(2);
    expect(findButton('除名')!.disabled).toBe(false);
  });

  it('脱退の通信が失敗 (fetch が reject) したら「脱退失敗」と通信エラーの文を出し、ホームへ移らずボタンを戻す', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    supabaseState.profile = { data: { org_role: 'member', organization_id: 'org-1' }, error: null };
    supabaseState.members = { data: membersOf('member'), error: null };
    await renderElement(createElement(MembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(callsOf('POST', '/api/org/leave')).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(`脱退失敗: ${NETWORK_FAILURE_REASON}`);
    expect(router.push).not.toHaveBeenCalled();
    expect(findButton('組織を脱退')!.disabled).toBe(false);
  });

  it('応答が届いたうえでの失敗 (4xx) は、これまでどおり理由の文を出す (通信エラーの文にしない)', async () => {
    mockFetch(() => jsonResponse(403, { error: { code: 'NOT_ORG_ADMIN' } }));
    supabaseState.profile = { data: { org_role: 'owner', organization_id: 'org-1' }, error: null };
    supabaseState.members = { data: membersOf('owner'), error: null };
    await renderElement(createElement(MembersPage));

    await click(findButton('除名'), 'Aさんの「除名」ボタン');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = String(alertSpy.mock.calls[0][0]);
    expect(message.startsWith('除名失敗: ')).toBe(true);
    expect(message).not.toContain(NETWORK_FAILURE_REASON);
    expect(message).not.toContain('応答を受け取れませんでした');
  });
});

describe('#2059 Q3 と同じ形 組織のメンバー: 脱退の応答を待つ間は「再試行」を止める', () => {
  it('一覧を読み込めなかった画面で脱退を押し、応答を待つ間に「再試行」を押しても一覧を読み直さない', async () => {
    const leave = deferred<Response>();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === '/api/org/leave') return leave.promise;
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    supabaseState.profile = { data: { org_role: 'member', organization_id: 'org-1' }, error: null };
    supabaseState.members = { data: null, error: { message: 'permission denied' } };
    await renderElement(createElement(MembersPage));

    expect(container.querySelector('[data-testid="member-load-error"]')).not.toBeNull();
    expect(supabaseState.membersQueryCount).toBe(1);
    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    const retry = findButton('再試行');
    expect(retry, '「再試行」ボタン').toBeDefined();
    expect(retry!.disabled).toBe(true);
    await click(retry, '「再試行」ボタン');
    expect(supabaseState.membersQueryCount).toBe(1);
    // 脱退の「処理中...」も出たまま (読み込み中の表示で隠さない)
    expect(findButton('処理中...')).toBeDefined();

    await act(async () => {
      leave.resolve(jsonResponse(200, { ok: true }));
    });
    await settle();
    expect(router.push).toHaveBeenCalledWith('/home');
  });
});
