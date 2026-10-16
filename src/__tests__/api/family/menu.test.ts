import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type DbError, type SchemaDb } from '../../../../tests/helpers/schema-checked-db';
import { makeClient, profileRow, uuid, type FakeUser } from '../../../../tests/helpers/route-world';
import { FamilyMenuDataSchema, FamilyMenuMealSchema } from '@/schemas/membership/family-menu';

// GET /api/family/menu — 週間献立の「家族の表示」で、家族のメンバーの献立を読み取り専用で返す (#1584 の 1)。
// 設計書 docs/design/family/10-family-menu-view.md §15・§19.2。
//
// 見てよい相手の判定と献立の絞り (鍵 12 個・砂場を除く) は DB の関数 2 本 (実 DB は tests/integration/rls/family-menu-visibility.test.ts)。
// ここでは route の手順 (認証 → 日付 → user_profiles.family_id → rpc 2 本 → Zod → まとめる) と、応答に余計な鍵が出ないことを、
// 偽のクライアント (tests/helpers/route-world.ts の makeClient に rpc の偽物を渡す) で確かめる。
// 凍結・メンテナンス・規約の同意は middleware が止める (lib/supabase/__tests__/middleware-family-menu.test.ts)。

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
  };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

let db: SchemaDb;
let sessionUser: FakeUser | null;
const rpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeClient(db, sessionUser, rpc),
  // 家族の献立は SECURITY DEFINER の関数で読むので、service_role は使わない
  getSupabaseAdmin: () => {
    throw new Error('GET /api/family/menu must not use the service role client');
  },
}));

const { GET } = await import('@/app/api/family/menu/route');

const ME = uuid(1);
const HUSBAND = uuid(2);
const GRANDMA = uuid(3);
const FAMILY_ID = uuid(100);
const M_HUSBAND = uuid(202);
const M_GRANDMA = uuid(203);
const MEAL_A = uuid(301);
const MEAL_B = uuid(302);

const START = '2026-10-12';
const END = '2026-10-18';

/** 偽の family_menu_planned_meals が返す要素 (関数の要素の 12 個の鍵 + 返してはいけない鍵) */
const GENERATED_IMAGE_URL = 'http://127.0.0.1:54321/storage/v1/object/public/fridge-images/generated/abc/a.png';
const EXTERNAL_IMAGE_URL = 'https://images.unsplash.com/photo-1';
const SECRET_MEMO = '夫のメモ (家族に見せない)';

function mealElement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    member_id: M_HUSBAND,
    user_id: HUSBAND,
    day_date: '2026-10-16',
    id: MEAL_A,
    meal_type: 'dinner',
    dish_name: '肉じゃが',
    dish_names: ['肉じゃが', '味噌汁'],
    is_simple: false,
    calories_kcal: 650,
    cooking_time_minutes: 30,
    display_order: 0,
    is_completed: false,
    ...overrides,
  };
}

interface RpcPlan {
  members?: { data: unknown; error: DbError | null };
  meals?: { data: unknown; error: DbError | null };
}

function setup(options: { user?: FakeUser | null; familyId?: string | null; profileError?: DbError; rpc?: RpcPlan } = {}) {
  sessionUser = options.user === undefined ? { id: ME } : options.user;
  const familyId = options.familyId === undefined ? FAMILY_ID : options.familyId;
  db = createSchemaDb({
    tables: {
      user_profiles: sessionUser ? [profileRow(sessionUser.id, { family_id: familyId })] : [],
    },
    errors: options.profileError ? { user_profiles: options.profileError } : undefined,
  });
  const plan: RpcPlan = options.rpc ?? {};
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'family_menu_visible_members') {
      return plan.members ?? { data: [{ member_id: M_HUSBAND, user_id: HUSBAND }], error: null };
    }
    if (fn === 'family_menu_planned_meals') {
      return plan.meals ?? { data: [mealElement()], error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
}

function request(query: string): Request {
  return new Request(`http://localhost/api/family/menu${query}`);
}

async function call(query = `?startDate=${START}&endDate=${END}`) {
  const res = await GET(request(query));
  const raw = await res.text();
  return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

describe('GET /api/family/menu (#1584 の 1)', () => {
  it('未認証は 401 NOT_AUTHENTICATED で、プロフィールも RPC も読まない', async () => {
    setup({ user: null });
    const { status, body } = await call();

    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } });
    expect(db.recorded('user_profiles')).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('startDate / endDate が無い・2026-02-30・逆順・32 日は 400 INVALID_REQUEST で、DB に触れない', async () => {
    for (const query of [
      '',
      `?startDate=${START}`,
      `?endDate=${END}`,
      '?startDate=2026-02-30&endDate=2026-03-01',
      '?startDate=2026-10-12&endDate=2026-10-40',
      '?startDate=20261012&endDate=2026-10-18',
      '?startDate=2026-10-18&endDate=2026-10-12',
      '?startDate=2026-10-01&endDate=2026-11-01',
    ]) {
      setup();
      const { status, body } = await call(query);
      expect(status, query).toBe(400);
      expect((body.error as { code: string }).code, query).toBe('INVALID_REQUEST');
      expect(db.recorded('user_profiles'), query).toHaveLength(0);
      expect(rpc, query).not.toHaveBeenCalled();
    }
    // 31 日はちょうど通る (境界)
    setup();
    const ok = await call('?startDate=2026-10-01&endDate=2026-10-31');
    expect(ok.status).toBe(200);
  });

  it('家族に居なければ 200 の family_id: null・members: [] で、RPC を呼ばない', async () => {
    setup({ familyId: null });
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({ data: { family_id: null, start_date: START, end_date: END, members: [] } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('見てよいメンバーと献立を、応答の形 (Zod strict) にまとめて返す。メモ・生成のメタデータ・dishes・image_url の鍵は無い', async () => {
    setup({
      rpc: {
        members: { data: [{ member_id: M_HUSBAND, user_id: HUSBAND }], error: null },
        meals: {
          data: [
            mealElement({
              memo: SECRET_MEMO,
              generation_metadata: { model: 'gpt', prompt: '秘密のプロンプト' },
              dishes: [{ name: '肉じゃが', calories_kcal: 300, ingredients: ['じゃがいも'], image_url: GENERATED_IMAGE_URL }],
              image_url: GENERATED_IMAGE_URL,
              mode: 'cook',
            }),
            mealElement({ id: MEAL_B, meal_type: 'lunch', display_order: 1, image_url: EXTERNAL_IMAGE_URL }),
          ],
          error: null,
        },
      },
    });
    const { status, body, raw } = await call();

    expect(status).toBe(200);
    const parsed = FamilyMenuDataSchema.safeParse((body as { data: unknown }).data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.family_id).toBe(FAMILY_ID);
    expect(parsed.data.members).toHaveLength(1);
    const meals = parsed.data.members[0].days.flatMap((d) => d.meals);
    expect(meals.map((m) => m.id)).toEqual([MEAL_A, MEAL_B]);
    const mealKeys = Object.keys(FamilyMenuMealSchema.shape).sort();
    expect(mealKeys).toHaveLength(9);
    for (const meal of meals) expect(Object.keys(meal).sort()).toEqual(mealKeys);
    expect(meals[0].dish_names).toEqual(['肉じゃが', '味噌汁']);
    for (const banned of ['memo', 'generation_metadata', '"dishes"', 'image_url', '"mode"']) {
      expect(raw, banned).not.toContain(banned);
    }
    for (const leaked of [GENERATED_IMAGE_URL, EXTERNAL_IMAGE_URL, SECRET_MEMO, '秘密のプロンプト', 'じゃがいも']) {
      expect(raw, leaked).not.toContain(leaked);
    }
  });

  it('family_menu_planned_meals の返り値が FamilyMenuRpcRowsSchema に合わない (配列でない・null・鍵の欠けた要素) なら 500 RPC_FAILED の固定の文で、元の値は本文に出さずログに残す', async () => {
    const { dish_name: _omitted, ...missingKey } = mealElement({ dish_name: '漏れてはいけない料理' });
    for (const data of [{ rows: [] }, null, [missingKey], [mealElement({ dish_names: null })]]) {
      setup({ rpc: { meals: { data, error: null } } });
      mocks.logError.mockClear();
      const { status, body, raw } = await call();
      expect(status, JSON.stringify(data)).toBe(500);
      expect(body).toEqual({ error: { code: 'RPC_FAILED', message: '家族の献立の取得に失敗しました' } });
      expect(raw).not.toContain('漏れてはいけない料理');
      expect(mocks.logError).toHaveBeenCalledTimes(1);
      expect(mocks.logError.mock.calls[0][0]).toContain('献立の形が想定と違う');
    }
  });

  it('献立の無いメンバーも members に入る (days: [])', async () => {
    setup({
      rpc: {
        members: {
          data: [
            { member_id: M_GRANDMA, user_id: GRANDMA },
            { member_id: M_HUSBAND, user_id: HUSBAND },
          ],
          error: null,
        },
        meals: { data: [mealElement()], error: null },
      },
    });
    const { status, body } = await call();

    expect(status).toBe(200);
    const data = (body as { data: { members: Array<{ member_id: string; days: unknown[] }> } }).data;
    expect(data.members.map((m) => m.member_id)).toEqual([M_GRANDMA, M_HUSBAND]);
    expect(data.members[0].days).toEqual([]);
    expect(data.members[1].days).toHaveLength(1);
  });

  it('family_id はあるが見てよいメンバーが 0 人 (自分が active でない) なら、200 で family_id はその家族・members: []', async () => {
    setup({ rpc: { members: { data: [], error: null }, meals: { data: [], error: null } } });
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({ data: { family_id: FAMILY_ID, start_date: START, end_date: END, members: [] } });
  });

  it('RPC の失敗は 500 RPC_FAILED の固定の文で、元のエラーは本文に出さずログに残す', async () => {
    const rawMessage = 'FAMILY_MENU_RANGE_INVALID: secret detail';
    for (const plan of [
      { members: { data: null, error: { message: rawMessage, code: 'P0001' } } },
      { meals: { data: null, error: { message: rawMessage, code: 'P0001' } } },
    ] satisfies RpcPlan[]) {
      setup({ rpc: plan });
      mocks.logError.mockClear();
      const { status, body, raw } = await call();
      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: 'RPC_FAILED', message: '家族の献立の取得に失敗しました' } });
      expect(raw).not.toContain(rawMessage);
      expect(mocks.logError).toHaveBeenCalledTimes(1);
      expect(mocks.logError.mock.calls[0][1]).toEqual(expect.objectContaining({ message: rawMessage }));
    }
  });

  it('プロフィールの取得の失敗は 500 RPC_FAILED', async () => {
    setup({ profileError: { message: 'connection reset', code: '08006' } });
    const { status, body, raw } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'RPC_FAILED', message: '家族の献立の取得に失敗しました' } });
    expect(raw).not.toContain('connection reset');
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('route は凍結・同意・メンテナンスを判定しない: user_profiles から select するのは family_id だけ', async () => {
    await call();

    const selects = db.recorded('user_profiles');
    expect(selects).toHaveLength(1);
    expect(selects[0].op).toBe('select');
    expect(selects[0].select).toBe('family_id');
    expect(selects[0].eq).toEqual([['id', ME]]);
  });

  it('rpc は family_menu_visible_members と family_menu_planned_meals を、startDate / endDate を p_start_date / p_end_date にしてこの順で呼ぶ', async () => {
    await call();

    expect(rpc.mock.calls).toEqual([
      ['family_menu_visible_members'],
      ['family_menu_planned_meals', { p_start_date: START, p_end_date: END }],
    ]);
  });
});
