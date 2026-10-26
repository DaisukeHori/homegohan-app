/**
 * #2064 (10/26 の整合ゲート 1026g の候補・triage-1026d) R4・R5 のテスト
 *
 *   - R4: 組織のオーナーの譲渡の画面 (/org/settings/owner-transfer) で、候補の問い合わせが失敗すると
 *     「譲渡可能なメンバーがいません。先にメンバーを招待してください。」と出ていた (error を見ていなかった)。
 *     自分のプロフィールの読み込みの失敗では、オーナーなのにメンバーの一覧へ戻され、例外が投げられたときは catch が無く未処理の reject になっていた。
 *     直したあとは、読み込めなかった旨の文と「再試行」を出し、空の一覧の文は読み込みに成功して 0 人のときだけ出す。
 *     同じ形の家族の代表者の譲渡の画面 (/family/representative-transfer) も同じ
 *   - R5: 組織のメンバーの画面で、除名の通信が失敗 (reject) したとき一覧を読み直さなかった。
 *     サーバーが除名を済ませてから応答が切れた場合でも、除名したメンバーが一覧に残っていた。
 *     直したあとは、通信エラーの文を出したうえで一覧を読み直す (読み直しが失敗したら、一覧の「読み込めませんでした」に任せる)
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
const FAMILY_ID = '88888888-8888-4888-8888-888888888888';
const FAMILY_MEMBER_B_ID = '99999999-9999-4999-8999-999999999999';

/** 画面の文 (画面と同じもの) */
const OWNER_TRANSFER_EMPTY = '譲渡可能なメンバーがいません。先にメンバーを招待してください。';
const OWNER_TRANSFER_LOAD_ERROR = '譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const MEMBERS_LOAD_ERROR = 'メンバーの一覧を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const NETWORK_FAILURE_REASON = '通信エラーが発生しました。通信状況を確認して、もう一度お試しください';
const FAMILY_TRANSFER_EMPTY = '代表者を引き継げるメンバーがいません。';
const FAMILY_TRANSFER_LOAD_ERROR = '代表者の譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const FAMILY_REPRESENTATIVE_ONLY = 'この操作は代表者のみが行えます';

type QueryResult = { data: unknown; error: unknown };
/** 問い合わせの結果。関数なら呼ぶたびに決める (読み直しで中身を変えるため)。reject を返すと例外の筋書きになる */
type ResultSource = QueryResult | (() => QueryResult | Promise<QueryResult>);

const supabaseState = vi.hoisted(() => ({
  /** auth.getUser が投げるか */
  getUserThrows: false,
  /** user_profiles の 1 行 (single) = 自分のプロフィール */
  profile: { data: null, error: null } as unknown,
  /** user_profiles の一覧 (await) = 組織のメンバー・譲渡の候補 */
  orgMembers: { data: null, error: null } as unknown,
  /** family_members の 1 行 (single / maybeSingle) = 家族の中の自分 */
  myFamilyMember: { data: null, error: null } as unknown,
  /** family_members の一覧 (await) = 代表者の譲渡の候補 */
  familyCandidates: { data: null, error: null } as unknown,
  /** 一覧の問い合わせを送った回数 */
  orgMembersQueryCount: 0,
  familyCandidatesQueryCount: 0,
}));

function resolveSource(source: unknown): Promise<QueryResult> {
  const s = source as ResultSource;
  return Promise.resolve(typeof s === 'function' ? s() : s);
}

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// 画面は Supabase の問い合わせで読む。表と、1 行 (single / maybeSingle) か一覧 (await) かで結果を分ける
vi.mock('@/lib/supabase/client', () => {
  const builder = (table: string) => {
    const one = () =>
      resolveSource(table === 'user_profiles' ? supabaseState.profile : supabaseState.myFamilyMember);
    const list = () => {
      if (table === 'user_profiles') {
        supabaseState.orgMembersQueryCount += 1;
        return resolveSource(supabaseState.orgMembers);
      }
      supabaseState.familyCandidatesQueryCount += 1;
      return resolveSource(supabaseState.familyCandidates);
    };
    const query = {
      select: () => query,
      eq: () => query,
      neq: () => query,
      in: () => query,
      order: () => query,
      single: one,
      maybeSingle: one,
      then: (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        list().then(onFulfilled, onRejected),
    };
    return query;
  };
  return {
    createClient: () => ({
      auth: {
        getUser: () =>
          supabaseState.getUserThrows
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve({ data: { user: { id: USER_ID } } }),
      },
      from: (table: string) => builder(table),
    }),
  };
});

const { default: OwnerTransferPage } = await import('@/app/(org)/org/settings/owner-transfer/page');
const { default: MembersPage } = await import('@/app/(org)/org/members/page');
const { default: FamilyRepresentativeTransferPage } = await import('@/app/(main)/family/representative-transfer/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  // 家族の名前の補完 (/api/family/members/names) は本題ではないので失敗させる (画面は display_name のまま出す)
  fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  supabaseState.getUserThrows = false;
  supabaseState.profile = { data: null, error: null };
  supabaseState.orgMembers = { data: null, error: null };
  supabaseState.myFamilyMember = { data: null, error: null };
  supabaseState.familyCandidates = { data: null, error: null };
  supabaseState.orgMembersQueryCount = 0;
  supabaseState.familyCandidatesQueryCount = 0;
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
// R4: 組織のオーナーの譲渡の画面
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R4 組織のオーナーの譲渡: 候補を読み込めなかったことを「譲渡可能なメンバーがいません」と見せない', () => {
  const ownerProfile = { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
  const candidateA = { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' };
  const loadErrorBox = () => container.querySelector('[data-testid="owner-transfer-load-error"]');

  it('候補の問い合わせが失敗したら、読み込めなかった文と「再試行」を出し、空の一覧の文を出さない', async () => {
    supabaseState.profile = ownerProfile;
    supabaseState.orgMembers = { data: null, error: { message: 'permission denied' } };
    await renderElement(createElement(OwnerTransferPage));

    expect(loadErrorBox()?.textContent).toContain(OWNER_TRANSFER_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(text()).not.toContain(OWNER_TRANSFER_EMPTY);
    expect(container.querySelector('form')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('自分のプロフィールの読み込みが失敗したら、メンバーの一覧へ戻さず、読み込めなかった文を出す', async () => {
    supabaseState.profile = { data: null, error: { message: 'connection reset' } };
    await renderElement(createElement(OwnerTransferPage));

    expect(router.push).not.toHaveBeenCalled();
    expect(loadErrorBox()?.textContent).toContain(OWNER_TRANSFER_LOAD_ERROR);
    expect(text()).not.toContain(OWNER_TRANSFER_EMPTY);
    // プロフィールを読めていないので、候補は問い合わせない
    expect(supabaseState.orgMembersQueryCount).toBe(0);
  });

  it('問い合わせが例外を投げても、未処理の reject にせず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(OwnerTransferPage));

    expect(loadErrorBox()?.textContent).toContain(OWNER_TRANSFER_LOAD_ERROR);
    expect(text()).not.toContain(OWNER_TRANSFER_EMPTY);
    expect(unhandled).toEqual([]);
  });

  it('候補の問い合わせが例外を投げても、読み込めなかった文を出す', async () => {
    supabaseState.profile = ownerProfile;
    supabaseState.orgMembers = () => Promise.reject(new TypeError('Failed to fetch'));
    await renderElement(createElement(OwnerTransferPage));

    expect(loadErrorBox()?.textContent).toContain(OWNER_TRANSFER_LOAD_ERROR);
    expect(text()).not.toContain(OWNER_TRANSFER_EMPTY);
    expect(unhandled).toEqual([]);
  });

  it('読み込みに成功して候補が 0 人のときは、これまでどおり空の一覧の文を出す (読み込めなかった文は出さない)', async () => {
    supabaseState.profile = ownerProfile;
    supabaseState.orgMembers = { data: [], error: null };
    await renderElement(createElement(OwnerTransferPage));

    expect(text()).toContain(OWNER_TRANSFER_EMPTY);
    expect(loadErrorBox()).toBeNull();
  });

  it('「再試行」で読み直し、読めたら候補を出す', async () => {
    supabaseState.profile = ownerProfile;
    supabaseState.orgMembers = { data: null, error: { message: 'permission denied' } };
    await renderElement(createElement(OwnerTransferPage));
    expect(supabaseState.orgMembersQueryCount).toBe(1);

    supabaseState.orgMembers = { data: [candidateA], error: null };
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(supabaseState.orgMembersQueryCount).toBe(2);
    expect(loadErrorBox()).toBeNull();
    expect(text()).toContain('Aさん');
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('オーナーでないとわかったときは、これまでどおりメンバーの一覧へ戻す', async () => {
    supabaseState.profile = { data: { org_role: 'admin', organization_id: ORG_ID }, error: null };
    await renderElement(createElement(OwnerTransferPage));

    expect(router.push).toHaveBeenCalledWith('/org/members');
    expect(loadErrorBox()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 と同じ形: 家族の代表者の譲渡の画面
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R4 と同じ形 家族の代表者の譲渡: 候補を読み込めなかったことを「引き継げるメンバーがいません」と見せない', () => {
  const familyProfile = { data: { family_id: FAMILY_ID }, error: null };
  const representative = { data: { role: 'representative' }, error: null };
  const adultB = { id: FAMILY_MEMBER_B_ID, role: 'adult', display_name: 'Bさん', user_id: MEMBER_B_ID };
  const loadErrorBox = () => container.querySelector('[data-testid="family-transfer-load-error"]');

  it('候補の問い合わせが失敗したら、読み込めなかった文と「再試行」を出し、空の一覧の文を出さない', async () => {
    supabaseState.profile = familyProfile;
    supabaseState.myFamilyMember = representative;
    supabaseState.familyCandidates = { data: null, error: { message: 'permission denied' } };
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(loadErrorBox()?.textContent).toContain(FAMILY_TRANSFER_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(text()).not.toContain(FAMILY_TRANSFER_EMPTY);
    expect(container.querySelector('form')).toBeNull();
  });

  it('自分のプロフィールの読み込みが失敗したら、家族の作成の画面へ送らず、読み込めなかった文を出す', async () => {
    supabaseState.profile = { data: null, error: { message: 'connection reset' } };
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(router.replace).not.toHaveBeenCalled();
    expect(loadErrorBox()?.textContent).toContain(FAMILY_TRANSFER_LOAD_ERROR);
    expect(supabaseState.familyCandidatesQueryCount).toBe(0);
  });

  it('家族の中の自分の役割の読み込みが失敗したら、「代表者のみ」と見せず、読み込めなかった文を出す', async () => {
    supabaseState.profile = familyProfile;
    supabaseState.myFamilyMember = { data: null, error: { message: 'connection reset' } };
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(text()).not.toContain(FAMILY_REPRESENTATIVE_ONLY);
    expect(loadErrorBox()?.textContent).toContain(FAMILY_TRANSFER_LOAD_ERROR);
    expect(supabaseState.familyCandidatesQueryCount).toBe(0);
  });

  it('家族の中の自分が代表者でない (行が無い) ときは、これまでどおり「代表者のみ」を出す', async () => {
    supabaseState.profile = familyProfile;
    supabaseState.myFamilyMember = { data: null, error: null };
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(text()).toContain(FAMILY_REPRESENTATIVE_ONLY);
    expect(loadErrorBox()).toBeNull();
  });

  it('問い合わせが例外を投げても、読み込み中のまま止まらず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(text()).not.toContain('読み込み中');
    expect(loadErrorBox()?.textContent).toContain(FAMILY_TRANSFER_LOAD_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('読み込みに成功して候補が 0 人のときは、これまでどおり空の一覧の文を出す', async () => {
    supabaseState.profile = familyProfile;
    supabaseState.myFamilyMember = representative;
    supabaseState.familyCandidates = { data: [], error: null };
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    expect(text()).toContain(FAMILY_TRANSFER_EMPTY);
    expect(loadErrorBox()).toBeNull();
  });

  it('「再試行」で読み直し、読めたら候補を出す', async () => {
    supabaseState.profile = familyProfile;
    supabaseState.myFamilyMember = representative;
    supabaseState.familyCandidates = { data: null, error: { message: 'permission denied' } };
    await renderElement(createElement(FamilyRepresentativeTransferPage));
    expect(supabaseState.familyCandidatesQueryCount).toBe(1);

    supabaseState.familyCandidates = { data: [adultB], error: null };
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(supabaseState.familyCandidatesQueryCount).toBe(2);
    expect(loadErrorBox()).toBeNull();
    expect(text()).toContain('Bさん');
    expect(container.querySelector('form')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5: 組織のメンバーの除名の通信が失敗したときの読み直し
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R5 組織のメンバー: 除名の通信が失敗 (reject) したら、一覧を読み直す', () => {
  const me = { id: USER_ID, nickname: 'わたし', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' };
  const memberA = { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' };
  const memberB = { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' };
  const removeCalls = () =>
    fetchMock.mock.calls.filter(([input]) => String(input) === `/api/org/members/${MEMBER_A_ID}/remove`);

  beforeEach(() => {
    supabaseState.profile = { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
  });

  it('サーバーが除名を済ませてから応答が切れたとき、通信エラーの文を出したうえで読み直し、除名したメンバーを一覧から消す', async () => {
    // サーバーの一覧。除名の POST を受け取った時点で A を除いてから、応答の前に通信が切れる
    let server = [me, memberA, memberB];
    supabaseState.orgMembers = () => ({ data: [...server], error: null });
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input) === `/api/org/members/${MEMBER_A_ID}/remove`) {
        server = server.filter((m) => m.id !== MEMBER_A_ID);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${String(input)}`);
    });
    await renderElement(createElement(MembersPage));
    expect(text()).toContain('Aさん');
    expect(supabaseState.orgMembersQueryCount).toBe(1);

    const removeA = Array.from(container.querySelectorAll('tr'))
      .find((row) => row.textContent?.includes('Aさん'))
      ?.querySelector('button') ?? undefined;
    await click(removeA, 'Aさんの「除名」ボタン');

    expect(removeCalls()).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(`除名失敗: ${NETWORK_FAILURE_REASON}`);
    expect(supabaseState.orgMembersQueryCount).toBe(2);
    expect(text()).not.toContain('Aさん');
    expect(text()).toContain('Bさん');
    // 読み直しのあとは、ほかのメンバーの「除名」をまた押せる
    expect(findButton('除名')!.disabled).toBe(false);
    expect(text()).toContain('組織メンバー (2 名)');
  });

  it('除名の通信が失敗し、読み直しも失敗したら、一覧の「読み込めませんでした」と「再試行」を出す', async () => {
    let loads = 0;
    supabaseState.orgMembers = () => {
      loads += 1;
      return loads === 1
        ? { data: [me, memberA], error: null }
        : { data: null, error: { message: 'connection reset' } };
    };
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await renderElement(createElement(MembersPage));

    await click(findButton('除名'), 'Aさんの「除名」ボタン');

    expect(alertSpy).toHaveBeenCalledWith(`除名失敗: ${NETWORK_FAILURE_REASON}`);
    expect(supabaseState.orgMembersQueryCount).toBe(2);
    const box = container.querySelector('[data-testid="member-load-error"]');
    expect(box?.textContent).toContain(MEMBERS_LOAD_ERROR);
    const retry = findButton('再試行');
    expect(retry).toBeDefined();
    expect(retry!.disabled).toBe(false);
  });

  it('応答が届いたうえでの失敗 (4xx) は、除名されていないので読み直さない (これまでどおり)', async () => {
    supabaseState.orgMembers = { data: [me, memberA], error: null };
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_ORG_ADMIN' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await renderElement(createElement(MembersPage));

    await click(findButton('除名'), 'Aさんの「除名」ボタン');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(supabaseState.orgMembersQueryCount).toBe(1);
    expect(text()).toContain('Aさん');
  });
});
