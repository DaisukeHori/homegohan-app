/**
 * useFamilyMenu (週間献立の家族の献立を取る hook) のテスト
 * (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §14.3・§19.4)。
 *
 * このリポジトリには @testing-library/react が無いため、hook を呼ぶだけの小さな部品を react-dom/client + act で描く。
 * fetch は global を差し替え、応答は it ごとに手で解決する (取得中に範囲が変わるときの順を固定するため)。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAMILY_MENU_CACHE_TTL_MS,
  useFamilyMenu,
  type UseFamilyMenuArgs,
  type UseFamilyMenuResult,
} from '@/hooks/useFamilyMenu';
import type { FamilyMenuData } from '@/schemas/membership/family-menu';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAMILY_ID = 'd0000000-0000-4000-8000-000000000001';
const HUSBAND_MEMBER = 'b0000000-0000-4000-8000-000000000002';
const HUSBAND_USER = 'a0000000-0000-4000-8000-000000000002';

/** 週 A と週 B (どちらも 7 日) */
const WEEK_A = { startDate: '2026-10-12', endDate: '2026-10-18' } as const;
const WEEK_B = { startDate: '2026-10-19', endDate: '2026-10-25' } as const;
/** テストの時計の起点 */
const T0 = new Date('2026-10-16T09:00:00+09:00').getTime();
/** TTL の境目の手前と先へ進める量 */
const JUST_BEFORE_TTL_MS = FAMILY_MENU_CACHE_TTL_MS - 1;
const PAST_TTL_MS = FAMILY_MENU_CACHE_TTL_MS + 1;
const HTTP_INTERNAL_ERROR = 500;

function menuOf(range: { startDate: string; endDate: string }, dishName: string): FamilyMenuData {
  return {
    family_id: FAMILY_ID,
    start_date: range.startDate,
    end_date: range.endDate,
    members: [
      {
        member_id: HUSBAND_MEMBER,
        user_id: HUSBAND_USER,
        days: [
          {
            day_date: range.startDate,
            meals: [
              {
                id: 'c0000000-0000-4000-8000-000000000001',
                meal_type: 'dinner',
                dish_name: dishName,
                dish_names: [dishName],
                is_simple: true,
                calories_kcal: null,
                cooking_time_minutes: null,
                display_order: 0,
                is_completed: false,
              },
            ],
          },
        ],
      },
    ],
  };
}

function okResponse(data: FamilyMenuData): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function failedResponse(): Response {
  return new Response(JSON.stringify({ error: { code: 'RPC_FAILED', message: 'x' } }), { status: HTTP_INTERNAL_ERROR });
}

/** 手で解決する fetch。呼ばれた URL と、その応答を返す関数を記録する */
interface PendingCall {
  url: string;
  resolve: (res: Response) => void;
}
let pending: PendingCall[];
let fetchMock: ReturnType<typeof vi.fn>;

let container: HTMLDivElement;
let root: Root;
let latest: UseFamilyMenuResult;

function Harness(props: UseFamilyMenuArgs) {
  latest = useFamilyMenu(props);
  return null;
}

function render(args: UseFamilyMenuArgs): void {
  act(() => root.render(createElement(Harness, args)));
}

/** fetch の応答と、その後の json() と setState を流す */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function respond(index: number, res: Response): Promise<void> {
  pending[index].resolve(res);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  pending = [];
  fetchMock = vi.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        pending.push({ url: String(input), resolve });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const enabledA: UseFamilyMenuArgs = { ...WEEK_A, enabled: true };
const enabledB: UseFamilyMenuArgs = { ...WEEK_B, enabled: true };

describe('useFamilyMenu', () => {
  it('enabled が false なら取らない (idle)', async () => {
    render({ ...WEEK_A, enabled: false });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest.status).toBe('idle');
    expect(latest.data).toBeNull();

    // true に変わったら取る
    render(enabledA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest.status).toBe('loading');
    expect(pending[0].url).toContain(`startDate=${WEEK_A.startDate}`);
    expect(pending[0].url).toContain(`endDate=${WEEK_A.endDate}`);
  });

  it('同じ範囲は 5 分以内なら取り直さない', async () => {
    expect(FAMILY_MENU_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    expect(latest.status).toBe('ready');

    // 別の週へ移って、TTL の手前で戻る → A は取り直さない
    render(enabledB);
    await respond(1, okResponse(menuOf(WEEK_B, 'B1')));
    vi.setSystemTime(T0 + JUST_BEFORE_TTL_MS);
    render(enabledA);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('A1');

    // TTL を超えてから移って戻ると取り直す (対照)
    render(enabledB);
    await settle();
    vi.setSystemTime(T0 + FAMILY_MENU_CACHE_TTL_MS + PAST_TTL_MS);
    render(enabledA);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reload は cache を捨てて取り直し、取り直しの間は同じ範囲の直前の data を返す', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    act(() => latest.reload());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.status).toBe('loading');
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('A1');
    await respond(1, okResponse(menuOf(WEEK_A, 'A2')));
    expect(latest.status).toBe('ready');
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('A2');
  });

  it('reload は全ての範囲の cache を捨てる (範囲 A と B を取ったあと A で reload し、TTL 内に B へ移ると B を取り直し、B の応答が届くまで data は null。前の B の応答を返さない)', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    render(enabledB);
    await respond(1, okResponse(menuOf(WEEK_B, 'B-old')));
    render(enabledA);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2); // A は cache

    act(() => latest.reload());
    await respond(2, okResponse(menuOf(WEEK_A, 'A2')));

    render(enabledB);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(pending[3].url).toContain(`startDate=${WEEK_B.startDate}`);
    expect(latest.data).toBeNull();
    await respond(3, okResponse(menuOf(WEEK_B, 'B-new')));
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('B-new');
  });

  it('同じ範囲の取り直しの失敗は error と reason を持ち、その範囲の直前の data を残す', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    act(() => latest.reload());
    await respond(1, failedResponse());
    expect(latest.status).toBe('error');
    expect(latest.reason).toBe('failed');
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('A1');

    // もう一度で直れば reason は消える
    act(() => latest.reload());
    await respond(2, okResponse(menuOf(WEEK_A, 'A2')));
    expect(latest.status).toBe('ready');
    expect(latest.reason).toBeNull();
  });

  it('範囲が変わると取り直し、新しい範囲の応答が届くまでは data が null (前の範囲の応答を返さない)', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    render(enabledB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.status).toBe('loading');
    expect(latest.data).toBeNull();
    await respond(1, okResponse(menuOf(WEEK_B, 'B1')));
    expect(latest.data?.start_date).toBe(WEEK_B.startDate);
  });

  it('範囲を戻すと、TTL 内ならその範囲の cache の data を返し取り直さない', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    render(enabledB);
    await respond(1, okResponse(menuOf(WEEK_B, 'B1')));
    render(enabledA);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest.status).toBe('ready');
    expect(latest.data?.start_date).toBe(WEEK_A.startDate);
    expect(latest.data?.members[0].days[0].meals[0].dish_name).toBe('A1');
  });

  it('同じ範囲・同じ enabled のまま時間を TTL の先へ進めても取り直さない (timer を持たない)', async () => {
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    vi.setSystemTime(T0 + PAST_TTL_MS);
    render(enabledA);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest.status).toBe('ready');
  });

  it('localStorage と sessionStorage に書かない (cache はメモリだけ。ログアウトの掃除の対象を増やさない)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(enabledA);
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    render(enabledB);
    await respond(1, okResponse(menuOf(WEEK_B, 'B1')));
    act(() => latest.reload());
    await respond(2, okResponse(menuOf(WEEK_B, 'B2')));
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('enabled が false の間に reload を呼んでも取らず idle のまま', async () => {
    render({ ...WEEK_A, enabled: false });
    act(() => latest.reload());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest.status).toBe('idle');
  });

  it('取得中に範囲が変わると、前の範囲の応答が後から届いても data にも cache にも入らない (戻ったときは取り直す)', async () => {
    render(enabledA);
    render(enabledB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await respond(0, okResponse(menuOf(WEEK_A, 'A-late')));
    expect(latest.status).toBe('loading');
    expect(latest.data).toBeNull();
    await respond(1, okResponse(menuOf(WEEK_B, 'B1')));
    expect(latest.data?.start_date).toBe(WEEK_B.startDate);

    // A に戻ると、届いて捨てた A の応答は cache に無いので取り直す
    render(enabledA);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(latest.data).toBeNull();
  });

  it('取得中に enabled が false になると、その応答が後から届いても status は idle のまま', async () => {
    render(enabledA);
    render({ ...WEEK_A, enabled: false });
    expect(latest.status).toBe('idle');
    await respond(0, okResponse(menuOf(WEEK_A, 'A1')));
    expect(latest.status).toBe('idle');
    expect(latest.data).toBeNull();
  });
});
