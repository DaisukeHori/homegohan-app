import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';
import {
  FAMILY_MENU_API_PATH,
  FAMILY_MENU_NOTE_TEXT,
  FAMILY_MENU_RANGE_MAX_DAYS,
  calendarDaySpan,
  familyMenuHasMealsOn,
  familyMenuMealLabel,
  familyMenuMealsOf,
  fetchFamilyMenu,
  groupFamilyMenuRows,
  isFamilyMenuRangeAllowed,
  partitionFamilyMenuMembers,
  visibleOtherMemberIdsOf,
  type FamilyMenuViewMember,
} from '@/lib/membership/family-menu';
import {
  FamilyMenuDataSchema,
  FamilyMenuResponseSchema,
  FamilyMenuRpcRowsSchema,
  type FamilyMenuData,
  type FamilyMenuMember,
  type FamilyMenuRpcRow,
} from '@/schemas/membership/family-menu';
// vitest の @/ の解決 (vitest.config.ts の at-alias) はフォルダの index を補わないので、barrel は index まで書いて読む
import * as membershipBarrel from '@/schemas/membership/index';
import * as familyMenuSchemas from '@/schemas/membership/family-menu';

// 週間献立の「家族の表示」の純関数・定数・受け取り (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §19.1)。

const ME = 'a0000000-0000-4000-8000-000000000001'; // 見る人 (user_id)
const HUSBAND_USER = 'a0000000-0000-4000-8000-000000000002';
const GRANDMA_USER = 'a0000000-0000-4000-8000-000000000003';
const LEFT_USER = 'a0000000-0000-4000-8000-000000000004';

const M_ME = 'b0000000-0000-4000-8000-000000000001';
const M_HUSBAND = 'b0000000-0000-4000-8000-000000000002';
const M_GRANDMA = 'b0000000-0000-4000-8000-000000000003';
const M_CHILD = 'b0000000-0000-4000-8000-000000000004';
const M_LEFT = 'b0000000-0000-4000-8000-000000000005';
/** 別の家族のメンバーの id (家族を移る前の visible_member_ids に残っていたもの) */
const M_OTHER_FAMILY = 'b0000000-0000-4000-8000-000000000099';

const MEAL_A = 'c0000000-0000-4000-8000-00000000000a';
const MEAL_B = 'c0000000-0000-4000-8000-00000000000b';
const MEAL_C = 'c0000000-0000-4000-8000-00000000000c';
const MEAL_D = 'c0000000-0000-4000-8000-00000000000d';

const FAMILY_ID = 'd0000000-0000-4000-8000-000000000001';

const MEMBERS: FamilyMenuViewMember[] = [
  { id: M_ME, user_id: ME, status: 'active' },
  { id: M_HUSBAND, user_id: HUSBAND_USER, status: 'active' },
  { id: M_GRANDMA, user_id: GRANDMA_USER, status: 'active' },
  { id: M_CHILD, user_id: null, status: 'active' },
  { id: M_LEFT, user_id: LEFT_USER, status: 'left' },
];

/** 応答の 1 人分 (献立の中身は it ごとに足す) */
function responseMember(memberId: string, userId: string, days: FamilyMenuMember['days'] = []): FamilyMenuMember {
  return { member_id: memberId, user_id: userId, days };
}

function rpcRow(overrides: Partial<FamilyMenuRpcRow> = {}): FamilyMenuRpcRow {
  return {
    member_id: M_HUSBAND,
    user_id: HUSBAND_USER,
    day_date: '2026-10-16',
    id: MEAL_A,
    meal_type: 'dinner',
    dish_name: '肉じゃが',
    dish_names: ['肉じゃが'],
    is_simple: false,
    calories_kcal: 600,
    cooking_time_minutes: 30,
    display_order: 0,
    is_completed: false,
    ...overrides,
  };
}

describe('calendarDaySpan / isFamilyMenuRangeAllowed', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('calendarDaySpan: 同じ日は 1、7 日の週は 7、逆順は 0 (実行環境のタイムゾーンを変えても同じ)', () => {
    for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = tz;
      expect(calendarDaySpan('2026-10-16', '2026-10-16'), tz).toBe(1);
      expect(calendarDaySpan('2026-10-12', '2026-10-18'), tz).toBe(7);
      expect(calendarDaySpan('2026-10-18', '2026-10-12'), tz).toBe(0);
      // 夏時間の切り替わり (米国 2026-03-08・2026-11-01) をまたいでも暦の差だけ
      expect(calendarDaySpan('2026-03-07', '2026-03-09'), tz).toBe(3);
      expect(calendarDaySpan('2026-10-31', '2026-11-02'), tz).toBe(3);
    }
  });

  it('isFamilyMenuRangeAllowed: 31 日は通り 32 日は通らない。逆順は通らない', () => {
    expect(FAMILY_MENU_RANGE_MAX_DAYS).toBe(31);
    expect(isFamilyMenuRangeAllowed('2026-10-01', '2026-10-31')).toBe(true);
    expect(isFamilyMenuRangeAllowed('2026-10-01', '2026-11-01')).toBe(false);
    expect(isFamilyMenuRangeAllowed('2026-10-16', '2026-10-16')).toBe(true);
    expect(isFamilyMenuRangeAllowed('2026-10-17', '2026-10-16')).toBe(false);
  });
});

describe('visibleOtherMemberIdsOf', () => {
  it('visibleOtherMemberIdsOf: all は active の全員から自分を除く', () => {
    expect(visibleOtherMemberIdsOf({ preset: 'all', visible_member_ids: [] }, MEMBERS, ME)).toEqual([
      M_HUSBAND,
      M_GRANDMA,
      M_CHILD,
    ]);
    // 一覧が自分だけ・空なら others も空 (S-22・S-28)
    expect(visibleOtherMemberIdsOf({ preset: 'all', visible_member_ids: [] }, [MEMBERS[0]], ME)).toEqual([]);
    expect(visibleOtherMemberIdsOf({ preset: 'all', visible_member_ids: [] }, [], ME)).toEqual([]);
  });

  it('visibleOtherMemberIdsOf: self は空', () => {
    expect(visibleOtherMemberIdsOf({ preset: 'self', visible_member_ids: [M_HUSBAND, M_ME] }, MEMBERS, ME)).toEqual([]);
  });

  it('visibleOtherMemberIdsOf: custom は visible_member_ids のうち active な既知の id だけ (退出した id・別の家族の id (家族を移る前の visible_member_ids) と自分は捨てる)', () => {
    expect(
      visibleOtherMemberIdsOf(
        { preset: 'custom', visible_member_ids: [M_ME, M_GRANDMA, M_LEFT, M_OTHER_FAMILY, M_CHILD] },
        MEMBERS,
        ME,
      ),
    ).toEqual([M_GRANDMA, M_CHILD]);
    // self_partner などの preset も visible_member_ids で絞る (all・self 以外)
    expect(
      visibleOtherMemberIdsOf({ preset: 'self_partner', visible_member_ids: [M_ME, M_HUSBAND] }, MEMBERS, ME),
    ).toEqual([M_HUSBAND]);
  });
});

describe('partitionFamilyMenuMembers', () => {
  const data: Pick<FamilyMenuData, 'members'> = {
    members: [responseMember(M_HUSBAND, HUSBAND_USER)],
  };

  it('partitionFamilyMenuMembers: 応答に居る → shown、アカウントがあって居ない → notSharing、user_id が null → noAccount、応答が null なら notSharing を作らない。otherIds に居ない人 (選ばなかった人) はどれにも入らない', () => {
    expect(partitionFamilyMenuMembers([M_HUSBAND, M_GRANDMA, M_CHILD], MEMBERS, data)).toEqual({
      shown: [M_HUSBAND],
      notSharing: [M_GRANDMA],
      noAccount: [M_CHILD],
    });
    expect(partitionFamilyMenuMembers([M_HUSBAND, M_GRANDMA, M_CHILD], MEMBERS, null)).toEqual({
      shown: [],
      notSharing: [],
      noAccount: [M_CHILD],
    });
    // 祖母は応答に居るが otherIds に居ない (選んでいない・一覧を読み直す前に加わった人) → どれにも入らない
    const withGrandma: Pick<FamilyMenuData, 'members'> = {
      members: [responseMember(M_HUSBAND, HUSBAND_USER), responseMember(M_GRANDMA, GRANDMA_USER)],
    };
    expect(partitionFamilyMenuMembers([M_HUSBAND], MEMBERS, withGrandma)).toEqual({
      shown: [M_HUSBAND],
      notSharing: [],
      noAccount: [],
    });
    // 一覧に居ない id (読み直す前の新しいメンバー) は捨てる
    expect(partitionFamilyMenuMembers([M_OTHER_FAMILY], MEMBERS, withGrandma)).toEqual({
      shown: [],
      notSharing: [],
      noAccount: [],
    });
  });

  it('partitionFamilyMenuMembers: 一覧の user_id が null のままのメンバーは、応答に居ても noAccount (昇格の後、家族の一覧を読み直す前)。user_id のある一覧に替えると、応答に居れば shown・居なければ notSharing', () => {
    const PROMOTED_USER = 'a0000000-0000-4000-8000-0000000000aa';
    const promoted: Pick<FamilyMenuData, 'members'> = { members: [responseMember(M_CHILD, PROMOTED_USER)] };
    expect(partitionFamilyMenuMembers([M_CHILD], MEMBERS, promoted)).toEqual({
      shown: [],
      notSharing: [],
      noAccount: [M_CHILD],
    });
    const reloaded = MEMBERS.map((m) => (m.id === M_CHILD ? { ...m, user_id: PROMOTED_USER } : m));
    expect(partitionFamilyMenuMembers([M_CHILD], reloaded, promoted)).toEqual({
      shown: [M_CHILD],
      notSharing: [],
      noAccount: [],
    });
    expect(partitionFamilyMenuMembers([M_CHILD], reloaded, { members: [] })).toEqual({
      shown: [],
      notSharing: [M_CHILD],
      noAccount: [],
    });
  });

  it('partitionFamilyMenuMembers: 応答の members が空 (family_id: null) なら、アカウントのある others は全員 notSharing', () => {
    expect(partitionFamilyMenuMembers([M_HUSBAND, M_GRANDMA, M_CHILD], MEMBERS, { members: [] })).toEqual({
      shown: [],
      notSharing: [M_HUSBAND, M_GRANDMA],
      noAccount: [M_CHILD],
    });
  });
});

describe('familyMenuHasMealsOn / familyMenuMealsOf', () => {
  const member = responseMember(M_HUSBAND, HUSBAND_USER, [
    {
      day_date: '2026-10-14',
      meals: [
        {
          id: MEAL_A,
          meal_type: 'breakfast',
          dish_name: 'トースト',
          dish_names: [],
          is_simple: true,
          calories_kcal: null,
          cooking_time_minutes: null,
          display_order: 0,
          is_completed: false,
        },
        {
          id: MEAL_B,
          meal_type: 'dinner',
          dish_name: '肉じゃが',
          dish_names: ['肉じゃが', '味噌汁'],
          is_simple: false,
          calories_kcal: 600,
          cooking_time_minutes: 30,
          display_order: 1,
          is_completed: true,
        },
      ],
    },
    { day_date: '2026-10-15', meals: [] },
  ]);

  it('familyMenuHasMealsOn: その日に 1 食でもあれば true。その日が days に無い・その日の meals が空・member が undefined なら false', () => {
    expect(familyMenuHasMealsOn(member, '2026-10-14')).toBe(true);
    expect(familyMenuHasMealsOn(member, '2026-10-16')).toBe(false);
    expect(familyMenuHasMealsOn(member, '2026-10-15')).toBe(false);
    expect(familyMenuHasMealsOn(undefined, '2026-10-14')).toBe(false);
  });

  it('familyMenuMealsOf: その日・その区分の食事だけ。無ければ []', () => {
    expect(familyMenuMealsOf(member, '2026-10-14', 'dinner').map((m) => m.id)).toEqual([MEAL_B]);
    expect(familyMenuMealsOf(member, '2026-10-14', 'lunch')).toEqual([]);
    expect(familyMenuMealsOf(member, '2026-10-16', 'dinner')).toEqual([]);
    expect(familyMenuMealsOf(undefined, '2026-10-14', 'dinner')).toEqual([]);
  });
});

describe('groupFamilyMenuRows', () => {
  const range = { family_id: FAMILY_ID, start_date: '2026-10-12', end_date: '2026-10-18' };
  const visible = [
    { member_id: M_GRANDMA, user_id: GRANDMA_USER },
    { member_id: M_HUSBAND, user_id: HUSBAND_USER },
  ];

  it('groupFamilyMenuRows: メンバーの順を保ち、日は昇順、食事は display_order → id の順。献立の無いメンバーは days: []', () => {
    const rows = [
      rpcRow({ id: MEAL_C, day_date: '2026-10-16', display_order: 1 }),
      rpcRow({ id: MEAL_B, day_date: '2026-10-16', display_order: 0 }),
      rpcRow({ id: MEAL_A, day_date: '2026-10-16', display_order: 0 }),
      rpcRow({ id: MEAL_D, day_date: '2026-10-13', display_order: 0 }),
    ];
    const data = groupFamilyMenuRows(visible, rows, range);

    expect(data.family_id).toBe(FAMILY_ID);
    expect(data.start_date).toBe(range.start_date);
    expect(data.end_date).toBe(range.end_date);
    expect(data.members.map((m) => m.member_id)).toEqual([M_GRANDMA, M_HUSBAND]);
    expect(data.members[0].days).toEqual([]);
    expect(data.members[1].days.map((d) => d.day_date)).toEqual(['2026-10-13', '2026-10-16']);
    expect(data.members[1].days[1].meals.map((m) => m.id)).toEqual([MEAL_A, MEAL_B, MEAL_C]);
    // 応答の形 (strict) に合う
    expect(FamilyMenuDataSchema.safeParse(data).success).toBe(true);
  });

  it('groupFamilyMenuRows: NULL の is_simple / display_order / is_completed を既定値にする。未知の meal_type の行と visible_members に居ない行は捨てる。dish_names はそのまま', () => {
    const rows = [
      rpcRow({
        id: MEAL_A,
        is_simple: null,
        display_order: null,
        is_completed: null,
        calories_kcal: null,
        cooking_time_minutes: null,
        dish_names: ['ご飯', '味噌汁', '焼き魚'],
      }),
      rpcRow({ id: MEAL_B, meal_type: 'teatime' }),
      rpcRow({ id: MEAL_C, member_id: M_OTHER_FAMILY, user_id: LEFT_USER }),
    ];
    const data = groupFamilyMenuRows(visible, rows, range);
    const husband = data.members.find((m) => m.member_id === M_HUSBAND);
    expect(husband?.days).toEqual([
      {
        day_date: '2026-10-16',
        meals: [
          {
            id: MEAL_A,
            meal_type: 'dinner',
            dish_name: '肉じゃが',
            dish_names: ['ご飯', '味噌汁', '焼き魚'],
            is_simple: true,
            calories_kcal: null,
            cooking_time_minutes: null,
            display_order: 0,
            is_completed: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(data)).not.toContain(MEAL_B);
    expect(JSON.stringify(data)).not.toContain(MEAL_C);
    expect(JSON.stringify(data)).not.toContain(M_OTHER_FAMILY);
  });

  it('groupFamilyMenuRows: 行に知らない鍵があっても応答の食事に写さない', () => {
    const extra = { ...rpcRow(), memo: '秘密のメモ', image_url: 'https://images.unsplash.com/photo-1' };
    const data = groupFamilyMenuRows(visible, [extra], range);
    const raw = JSON.stringify(data);
    expect(raw).not.toContain('秘密のメモ');
    expect(raw).not.toContain('images.unsplash.com');
    expect(FamilyMenuDataSchema.safeParse(data).success).toBe(true);
  });
});

describe('familyMenuMealLabel', () => {
  it('familyMenuMealLabel: 2 品以上なら「(全 n 品)」(n = dish_names の数)、is_simple なら dish_name だけ', () => {
    expect(familyMenuMealLabel({ dish_name: '肉じゃが', dish_names: ['肉じゃが', '味噌汁', 'ご飯'], is_simple: false })).toBe(
      '肉じゃが (全 3 品)',
    );
    expect(familyMenuMealLabel({ dish_name: '肉じゃが', dish_names: ['肉じゃが'], is_simple: false })).toBe('肉じゃが');
    expect(familyMenuMealLabel({ dish_name: '肉じゃが', dish_names: [], is_simple: false })).toBe('肉じゃが');
    expect(familyMenuMealLabel({ dish_name: 'カレー', dish_names: ['カレー', 'サラダ'], is_simple: true })).toBe('カレー');
  });
});

describe('FamilyMenuRpcRowsSchema', () => {
  it('FamilyMenuRpcRowsSchema: 12 の鍵の要素の配列を読み、is_simple / calories_kcal / cooking_time_minutes / display_order / is_completed の null を通し、知らない鍵 (memo・image_url など) は捨てる。配列でない値・null・鍵の欠けた要素・型の違う要素 (dish_names が null・day_date が日付の形でない) は通らない', () => {
    const nullable = rpcRow({
      is_simple: null,
      calories_kcal: null,
      cooking_time_minutes: null,
      display_order: null,
      is_completed: null,
    });
    const withExtra = {
      ...rpcRow({ id: MEAL_B }),
      memo: 'メモ',
      generation_metadata: { model: 'x' },
      dishes: [{ name: '肉じゃが', calories_kcal: 300 }],
      image_url: 'https://images.unsplash.com/photo-1',
      mode: 'cook',
    };
    const parsed = FamilyMenuRpcRowsSchema.safeParse([nullable, withExtra]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data[0]).toEqual(nullable);
    expect(Object.keys(parsed.data[1]).sort()).toEqual(Object.keys(rpcRow()).sort());
    expect(Object.keys(rpcRow())).toHaveLength(12);
    expect(FamilyMenuRpcRowsSchema.safeParse([]).success).toBe(true);

    const { dish_name: _omitted, ...missing } = rpcRow();
    for (const bad of [
      {},
      null,
      'not-array',
      [missing],
      [{ ...rpcRow(), dish_names: null }],
      [{ ...rpcRow(), day_date: '2026/10/16' }],
      [{ ...rpcRow(), id: 'not-uuid' }],
      [{ ...rpcRow(), calories_kcal: '600' }],
    ]) {
      expect(FamilyMenuRpcRowsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('fetchFamilyMenu', () => {
  const okData: FamilyMenuData = {
    family_id: FAMILY_ID,
    start_date: '2026-10-12',
    end_date: '2026-10-18',
    members: [responseMember(M_HUSBAND, HUSBAND_USER)],
  };

  function respond(status: number, body: unknown): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  it('fetchFamilyMenu: 200 の正しい本文は ok、401 は unauthorized、400 は invalid、403 (AUTH_ACCOUNT_FROZEN と LEGAL_CONSENT_REQUIRED の本文)・503 (MAINTENANCE_MODE の本文)・500 と形の違う本文と例外は failed (例外を投げない)', async () => {
    await expect(fetchFamilyMenu('2026-10-12', '2026-10-18', respond(200, { data: okData }))).resolves.toEqual({
      ok: true,
      data: okData,
    });
    await expect(
      fetchFamilyMenu('2026-10-12', '2026-10-18', respond(401, { error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } })),
    ).resolves.toEqual({ ok: false, reason: 'unauthorized' });
    await expect(
      fetchFamilyMenu('2026-10-12', '2026-10-18', respond(400, { error: { code: 'INVALID_REQUEST', message: 'x' } })),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });

    const failedResponses: Array<[number, unknown]> = [
      [403, { error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } }],
      [403, { error: '規約への同意が必要です', code: 'LEGAL_CONSENT_REQUIRED' }],
      [503, { error: 'ただいまメンテナンス中です。', code: 'MAINTENANCE_MODE', retryAfter: 600 }],
      [500, { error: { code: 'RPC_FAILED', message: '家族の献立の取得に失敗しました' } }],
      [200, { data: { ...okData, members: 'broken' } }],
      [200, { notData: okData }],
    ];
    for (const [status, body] of failedResponses) {
      await expect(fetchFamilyMenu('2026-10-12', '2026-10-18', respond(status, body)), `${status} ${JSON.stringify(body)}`).resolves.toEqual({
        ok: false,
        reason: 'failed',
      });
    }

    const throwing: typeof fetch = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await expect(fetchFamilyMenu('2026-10-12', '2026-10-18', throwing)).resolves.toEqual({ ok: false, reason: 'failed' });

    const notJson: typeof fetch = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(fetchFamilyMenu('2026-10-12', '2026-10-18', notJson)).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('fetchFamilyMenu: 同じオリジンの相対パス (FAMILY_MENU_API_PATH で始まり、startDate / endDate のクエリを持つ URL) を cache: \'no-store\' で呼ぶ', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: okData }), { status: 200 }));
    await fetchFamilyMenu('2026-10-12', '2026-10-18', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0];
    expect(typeof input).toBe('string');
    const url = String(input);
    expect(url.startsWith(`${FAMILY_MENU_API_PATH}?`)).toBe(true);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(query.get('startDate')).toBe('2026-10-12');
    expect(query.get('endDate')).toBe('2026-10-18');
    expect(init).toEqual({ cache: 'no-store' });
    expect(FAMILY_MENU_API_PATH).toBe('/api/family/menu');
  });
});

describe('barrel と定数', () => {
  it('barrel: @/schemas/membership から読んだ FamilyMenuDataSchema と FamilyMenuResponseSchema は @/schemas/membership/family-menu のものと同じ (index.ts の再 export)', () => {
    expect(membershipBarrel.FamilyMenuDataSchema).toBe(familyMenuSchemas.FamilyMenuDataSchema);
    expect(membershipBarrel.FamilyMenuResponseSchema).toBe(familyMenuSchemas.FamilyMenuResponseSchema);
    expect(membershipBarrel.FamilyMenuDataSchema).toBe(FamilyMenuDataSchema);
    expect(membershipBarrel.FamilyMenuResponseSchema).toBe(FamilyMenuResponseSchema);
  });

  it('FAMILY_MENU_NOTE_TEXT: 5 つの鍵 (notSharing / noAccount / noMealsToday / loadFailed / loading) を持ち、{name} を持つのは notSharing / noAccount / noMealsToday だけ', () => {
    expect(Object.keys(FAMILY_MENU_NOTE_TEXT).sort()).toEqual(
      ['loadFailed', 'loading', 'noAccount', 'noMealsToday', 'notSharing'].sort(),
    );
    const withName = Object.entries(FAMILY_MENU_NOTE_TEXT)
      .filter(([, text]) => text.includes('{name}'))
      .map(([key]) => key)
      .sort();
    expect(withName).toEqual(['noAccount', 'noMealsToday', 'notSharing']);
  });

  it('FamilyMenuMealTypeSchema は正本 MEAL_ORDER の区分だけを受ける', () => {
    for (const mealType of MEAL_ORDER) {
      expect(familyMenuSchemas.FamilyMenuMealTypeSchema.safeParse(mealType).success, mealType).toBe(true);
    }
    expect(familyMenuSchemas.FamilyMenuMealTypeSchema.safeParse('teatime').success).toBe(false);
    expect(familyMenuSchemas.FamilyMenuMealTypeSchema.safeParse(1).success).toBe(false);
  });
});
