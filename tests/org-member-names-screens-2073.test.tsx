/**
 * #2073 S4 組織のメンバーの一覧と、オーナーの譲渡の候補に、ほかのメンバーの名前が出ることのテスト
 *
 * 2 つの画面は以前、user_profiles を Supabase の問い合わせで直接読んでいた。user_profiles の SELECT の RLS は本人の行だけなので、
 * 本番では組織のメンバーの一覧に自分しか出ず、オーナーの譲渡の候補は 1 人も出なかった。
 * 直したあとは、自分のプロフィール (自分の行。RLS で読める) だけを Supabase で読み、ほかのメンバーはサーバーの API
 * (GET /api/org/members・GET /api/org/owner-transfer/candidates) から受け取る。API が返すのは id・表示名・組織内の役割・参加した日だけ。
 * 読み込めなかったときの扱い (読み込めなかった文と「再試行」。#2050・#2064) は保つ。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_B_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';

/** 画面の文 (画面と同じもの) */
const MEMBERS_LOAD_ERROR = 'メンバーの一覧を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const CANDIDATES_LOAD_ERROR = '譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const CANDIDATES_EMPTY = '譲渡可能なメンバーがいません。先にメンバーを招待してください。';

const MEMBERS_API = '/api/org/members';
const CANDIDATES_API = '/api/org/owner-transfer/candidates';

const supabaseState = vi.hoisted(() => ({
  /** 自分のプロフィール (single) の結果 */
  profile: { data: null as unknown, error: null as unknown },
  /** 画面が Supabase に渡した select の列 (自分の行だけを読んでいることを確かめる) */
  selects: [] as string[],
}));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// 画面が Supabase で読むのは自分のプロフィールの 1 行 (single) だけ。一覧の問い合わせ (order・neq・await) は用意しない
// (以前のように user_profiles の一覧を直接読もうとすると、ここで落ちて「読み込めませんでした」になる)
vi.mock('@/lib/supabase/client', () => {
  const builder = () => {
    const query = {
      select: (columns: string) => {
        supabaseState.selects.push(columns);
        return query;
      },
      eq: () => query,
      single: () => Promise.resolve(supabaseState.profile),
    };
    return query;
  };
  const client = {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
    from: () => builder(),
  };
  return { createClient: () => client };
});

const { default: MembersPage } = await import('@/app/(org)/org/members/page');
const { default: OwnerTransferPage } = await import('@/app/(org)/org/settings/owner-transfer/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

const text = () => container.textContent ?? '';
const getCalls = (path: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return method === 'GET' && String(input) === path;
  });

const me = { id: USER_ID, nickname: 'わたし', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' };
const memberA = { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'admin', joined_org_at: '2026-10-02T03:00:00.000Z' };
const memberB = { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi.fn(async (input: string) => {
    throw new Error(`想定していない fetch: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  supabaseState.profile = { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
  supabaseState.selects = [];
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#2073 S4 組織のメンバーの一覧: ほかのメンバーの名前を API から受け取って出す', () => {
  it('API が返したほかのメンバーの名前・役割を一覧に出し、人数も API の人数にする', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { members: [me, memberA, memberB] }));
    await renderElement(createElement(MembersPage));

    expect(getCalls(MEMBERS_API)).toHaveLength(1);
    expect(text()).toContain('Aさん');
    expect(text()).toContain('Bさん');
    expect(text()).toContain('組織メンバー (3 名)');
    expect(text()).toContain('管理者');
    // 自分の行には「(あなた)」
    const myRow = Array.from(container.querySelectorAll('tr')).find((row) => row.textContent?.includes('わたし'));
    expect(myRow?.textContent).toContain('(あなた)');
  });

  it('画面が Supabase で読むのは自分のプロフィールの役割と組織だけ (ほかの人の user_profiles を直接読まない)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { members: [me, memberA] }));
    await renderElement(createElement(MembersPage));

    expect(supabaseState.selects).toEqual(['org_role, organization_id']);
  });

  it('API が失敗 (403) したら、読み込めなかった文と「再試行」を出し、空の一覧の文を出さない。再試行で読めたら名前を出す', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(403, { error: 'この操作を行う権限がありません' })
        : jsonResponse(200, { members: [me, memberA] });
    });
    await renderElement(createElement(MembersPage));

    expect(container.querySelector('[data-testid="member-load-error"]')?.textContent).toContain(MEMBERS_LOAD_ERROR);
    expect(text()).not.toContain('メンバーがいません');
    expect(text()).not.toContain('(0 名)');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(getCalls(MEMBERS_API)).toHaveLength(2);
    expect(container.querySelector('[data-testid="member-load-error"]')).toBeNull();
    expect(text()).toContain('Aさん');
  });

  it('API の応答の形が違うときも、読み込めなかった文を出す (空の一覧と見せない)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { data: [me, memberA] }));
    await renderElement(createElement(MembersPage));

    expect(container.querySelector('[data-testid="member-load-error"]')?.textContent).toContain(MEMBERS_LOAD_ERROR);
    expect(text()).not.toContain('メンバーがいません');
  });

  it('API の通信が失敗 (reject) しても、未処理の reject にせず、読み込めなかった文を出す', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await renderElement(createElement(MembersPage));

    expect(container.querySelector('[data-testid="member-load-error"]')?.textContent).toContain(MEMBERS_LOAD_ERROR);
  });

  it('自分のプロフィールを読めなかったときは、API を呼ばずに読み込めなかった文を出す', async () => {
    supabaseState.profile = { data: null, error: { message: 'JWT expired', code: 'PGRST301' } };
    await renderElement(createElement(MembersPage));

    expect(getCalls(MEMBERS_API)).toHaveLength(0);
    expect(container.querySelector('[data-testid="member-load-error"]')?.textContent).toContain(MEMBERS_LOAD_ERROR);
  });
});

describe('#2073 S4 オーナーの譲渡: 候補の名前を API から受け取って出す', () => {
  it('API が返した候補の名前を出し、選んで提案できる形 (フォーム) にする', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { candidates: [memberA, memberB] }));
    await renderElement(createElement(OwnerTransferPage));

    expect(getCalls(CANDIDATES_API)).toHaveLength(1);
    expect(text()).toContain('Aさん');
    expect(text()).toContain('Bさん');
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(text()).not.toContain(CANDIDATES_EMPTY);
  });

  it('画面が Supabase で読むのは自分のプロフィールの役割と組織だけ', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { candidates: [memberA] }));
    await renderElement(createElement(OwnerTransferPage));

    expect(supabaseState.selects).toEqual(['org_role, organization_id']);
  });

  it('API が失敗 (500) したら、読み込めなかった文と「再試行」を出し、空の一覧の文を出さない。再試行で読めたら候補を出す', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(500, { error: 'サーバーエラーが発生しました' })
        : jsonResponse(200, { candidates: [memberB] });
    });
    await renderElement(createElement(OwnerTransferPage));

    expect(container.querySelector('[data-testid="owner-transfer-load-error"]')?.textContent).toContain(CANDIDATES_LOAD_ERROR);
    expect(text()).not.toContain(CANDIDATES_EMPTY);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(getCalls(CANDIDATES_API)).toHaveLength(2);
    expect(container.querySelector('[data-testid="owner-transfer-load-error"]')).toBeNull();
    expect(text()).toContain('Bさん');
  });

  it('API の応答の形が違うときも、読み込めなかった文を出す', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { members: [memberA] }));
    await renderElement(createElement(OwnerTransferPage));

    expect(container.querySelector('[data-testid="owner-transfer-load-error"]')?.textContent).toContain(CANDIDATES_LOAD_ERROR);
    expect(text()).not.toContain(CANDIDATES_EMPTY);
  });

  it('読み込みに成功して候補が 0 人のときは、これまでどおり空の一覧の文を出す', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { candidates: [] }));
    await renderElement(createElement(OwnerTransferPage));

    expect(text()).toContain(CANDIDATES_EMPTY);
    expect(container.querySelector('[data-testid="owner-transfer-load-error"]')).toBeNull();
  });

  it('オーナーでないときは、API を呼ばずにメンバーの一覧へ戻す (これまでどおり)', async () => {
    supabaseState.profile = { data: { org_role: 'admin', organization_id: ORG_ID }, error: null };
    await renderElement(createElement(OwnerTransferPage));

    expect(router.push).toHaveBeenCalledWith('/org/members');
    expect(getCalls(CANDIDATES_API)).toHaveLength(0);
  });
});
