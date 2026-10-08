/**
 * #1040 / #1306 ハンズオンツアーの吹き出しに差し込むプロフィール情報 (src/lib/handson-tour/tour-profile.ts) のテスト
 *
 * 保存先は次のとおりで、ページが以前 select していた列 (user_profiles.allergies / dislikes /
 * target_kcal_per_day) はどれも存在しない。
 *   - アレルギー・苦手な食材: user_profiles.diet_flags (jsonb) の { allergies, dislikes }
 *   - 目標カロリー: nutrition_targets.daily_calories
 *
 * ここでは次を確認する。
 *   - 取得した行 (jsonb を含む) から、吹き出しに使う値への変換 (型崩れ・欠損に強いこと)
 *   - 存在する列だけを select し、行が無い場合は失敗ではなく、失敗した場合はツアーを止めずに failures で返すこと
 *   - 失敗の記録 (計測 handson_tour_step_error + サーバーログ) が、共通 package の検証スキーマを満たすこと
 * ページに組み込んだ状態は tests/handson-tour-profile-pages.test.tsx、実際の DB に対しては
 * tests/integration/rls/handson-tour-profile-read.test.ts で確認する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_MENU_TOUR_PROFILE,
  EMPTY_PHOTO_TOUR_PROFILE,
  fetchMenuTourProfile,
  fetchPhotoTourProfile,
  toMenuTourProfile,
  toPhotoTourProfile,
  toStringList,
  toTargetKcal,
  type TourProfileClient,
} from '@/lib/handson-tour/tour-profile';
import { reportTourProfileFailures } from '@/lib/handson-tour/tour-profile-report';
import { HandsonTourEventSchemas } from '@homegohan/handson-tour-shared';
import { createFakeTourDb, pgError } from './helpers/fake-tour-profile-db';
import { parseSelectItem, splitTopLevel } from './helpers/select-columns';

const mocks = vi.hoisted(() => ({
  fireAnalytics: vi.fn(),
  logToServer: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  logToServer: mocks.logToServer,
}));

vi.mock('@homegohan/handson-tour-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@homegohan/handson-tour-shared')>()),
  fireAnalytics: mocks.fireAnalytics,
}));

const USER_ID = '22222222-2222-4222-8222-222222222222';

function selectedColumns(select: string): string[] {
  return splitTopLevel(select)
    .map((item) => parseSelectItem(item)?.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

beforeEach(() => {
  mocks.fireAnalytics.mockReset();
  mocks.logToServer.mockReset();
});

describe('toStringList: jsonb の配列を「空でない文字列だけの配列」にする', () => {
  it('前後の空白を取り、空文字・空白だけ・文字列以外を捨てる', () => {
    expect(toStringList(['えび', ' 卵 ', '', '   ', 3, null, undefined, {}, ['x']])).toEqual(['えび', '卵']);
  });

  it.each([[null], [undefined], ['えび'], [123], [{ 0: 'えび' }], [true]])('配列でない値 (%j) は空配列にする', (value) => {
    expect(toStringList(value)).toEqual([]);
  });
});

describe('toMenuTourProfile: user_profiles の行から Step2 の吹き出し用に変換する', () => {
  it('nickname / cooking_experience と、diet_flags の allergies / dislikes を取り出す', () => {
    expect(
      toMenuTourProfile({
        nickname: 'はなこ',
        diet_flags: { allergies: ['えび', '卵'], dislikes: ['セロリ'] },
        cooking_experience: 'advanced',
      }),
    ).toEqual({
      nickname: 'はなこ',
      allergies: ['えび', '卵'],
      dislikes: ['セロリ'],
      cooking_experience: 'advanced',
    });
  });

  it('diet_flags が NULL なら除外食材は空 (onboarding でアレルギーを答えていない人)', () => {
    expect(toMenuTourProfile({ nickname: 'はなこ', diet_flags: null, cooking_experience: 'beginner' })).toEqual({
      nickname: 'はなこ',
      allergies: [],
      dislikes: [],
      cooking_experience: 'beginner',
    });
  });

  it('allergies だけ / dislikes だけでも読める (onboarding は片方だけの保存もありうる)', () => {
    expect(toMenuTourProfile({ diet_flags: { allergies: ['えび'] } })).toMatchObject({ allergies: ['えび'], dislikes: [] });
    expect(toMenuTourProfile({ diet_flags: { dislikes: ['セロリ'] } })).toMatchObject({ allergies: [], dislikes: ['セロリ'] });
  });

  it.each([
    ['配列', ['えび']],
    ['文字列', 'えび'],
    ['数値', 1],
    ['true', true],
  ])('diet_flags の形が想定外 (%s) でも例外にせず、除外食材は空にする', (_label, dietFlags) => {
    expect(toMenuTourProfile({ nickname: 'はなこ', diet_flags: dietFlags })).toMatchObject({
      nickname: 'はなこ',
      allergies: [],
      dislikes: [],
    });
  });

  it('allergies が配列でない (文字列など) なら空にする', () => {
    expect(toMenuTourProfile({ diet_flags: { allergies: 'えび', dislikes: { a: 1 } } })).toMatchObject({
      allergies: [],
      dislikes: [],
    });
  });

  it('nickname / cooking_experience が文字列でなければ null', () => {
    expect(toMenuTourProfile({ nickname: 5, cooking_experience: {} })).toMatchObject({
      nickname: null,
      cooking_experience: null,
    });
  });

  it.each([[null], [undefined], ['x'], [[]]])('行そのものが想定外 (%j) なら既定値', (row) => {
    expect(toMenuTourProfile(row)).toEqual(EMPTY_MENU_TOUR_PROFILE);
  });
});

describe('toTargetKcal: nutrition_targets.daily_calories を目標カロリーにする', () => {
  it('正の有限な数値はそのまま', () => {
    expect(toTargetKcal(2000)).toBe(2000);
    expect(toTargetKcal(1800.5)).toBe(1800.5);
  });

  it.each([[0], [-100], [NaN], [Infinity], ['2000'], [null], [undefined], [{}], [true]])(
    '使えない値 (%j) は null (吹き出しで 0 除算 / NaN% にならないように)',
    (value) => {
      expect(toTargetKcal(value)).toBeNull();
    },
  );
});

describe('toPhotoTourProfile: Step1 の吹き出し用に変換する', () => {
  it('user_profiles.nickname と nutrition_targets.daily_calories を取り出す', () => {
    expect(toPhotoTourProfile({ nickname: 'はなこ' }, { daily_calories: 2000 })).toEqual({
      nickname: 'はなこ',
      target_kcal: 2000,
    });
  });

  it('どちらかの行が無くても、もう一方は使う', () => {
    expect(toPhotoTourProfile(null, { daily_calories: 2000 })).toEqual({ nickname: null, target_kcal: 2000 });
    expect(toPhotoTourProfile({ nickname: 'はなこ' }, null)).toEqual({ nickname: 'はなこ', target_kcal: null });
    expect(toPhotoTourProfile(null, null)).toEqual(EMPTY_PHOTO_TOUR_PROFILE);
  });
});

describe('fetchMenuTourProfile', () => {
  it('存在する列だけを、自分の行 (id) に絞って 1 回の問い合わせで取得して変換する', async () => {
    const db = createFakeTourDb({
      userId: USER_ID,
      profile: { nickname: 'はなこ', diet_flags: { allergies: ['えび'], dislikes: ['セロリ'] }, cooking_experience: 'intermediate' },
    });

    const result = await fetchMenuTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result).toEqual({
      profile: { nickname: 'はなこ', allergies: ['えび'], dislikes: ['セロリ'], cooking_experience: 'intermediate' },
      failures: [],
    });
    expect(db.schemaViolations).toEqual([]);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].table).toBe('user_profiles');
    expect(selectedColumns(db.queries[0].select)).toEqual(['cooking_experience', 'diet_flags', 'nickname']);
    expect(db.queries[0].filters).toEqual([['id', USER_ID]]);
  });

  it('行が無いのは失敗ではない (既定値で、failures は空)', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: null });

    const result = await fetchMenuTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result).toEqual({ profile: EMPTY_MENU_TOUR_PROFILE, failures: [] });
  });

  it('PostgREST のエラーは failures に入れ、既定値を返す (例外にしない)', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: { nickname: 'はなこ' } });
    db.failNext('user_profiles', pgError('42703', 'column user_profiles.allergies does not exist'));

    const result = await fetchMenuTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result.profile).toEqual(EMPTY_MENU_TOUR_PROFILE);
    expect(result.failures).toEqual([
      { table: 'user_profiles', code: '42703', message: 'column user_profiles.allergies does not exist' },
    ]);
  });

  it('問い合わせが例外 (ネットワーク断など) でも failures に入れ、既定値を返す', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: { nickname: 'はなこ' } });
    db.throwNext('user_profiles', new TypeError('Failed to fetch'));

    const result = await fetchMenuTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result.profile).toEqual(EMPTY_MENU_TOUR_PROFILE);
    expect(result.failures).toEqual([{ table: 'user_profiles', code: null, message: 'Failed to fetch' }]);
  });

  it('存在しない列を select する実装だと、フェイクは 42703 を返す (このテストの検出力の確認)', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: { nickname: 'はなこ' } });

    // 修正前のページと同じ select
    const { data, error } = await db.supabase
      .from('user_profiles')
      .select('nickname, allergies, dislikes, cooking_experience')
      .eq('id', USER_ID)
      .maybeSingle();

    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '42703', message: 'column user_profiles.allergies does not exist' });
  });
});

describe('fetchPhotoTourProfile', () => {
  it('ニックネームは user_profiles.id、目標カロリーは nutrition_targets.user_id で、存在する列だけを取得する', async () => {
    const db = createFakeTourDb({
      userId: USER_ID,
      profile: { nickname: 'はなこ' },
      nutritionTarget: { daily_calories: 2000 },
    });

    const result = await fetchPhotoTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result).toEqual({ profile: { nickname: 'はなこ', target_kcal: 2000 }, failures: [] });
    expect(db.schemaViolations).toEqual([]);
    const profileQuery = db.queries.find((q) => q.table === 'user_profiles')!;
    const targetQuery = db.queries.find((q) => q.table === 'nutrition_targets')!;
    expect(selectedColumns(profileQuery.select)).toEqual(['nickname']);
    expect(profileQuery.filters).toEqual([['id', USER_ID]]);
    expect(selectedColumns(targetQuery.select)).toEqual(['daily_calories']);
    expect(targetQuery.filters).toEqual([['user_id', USER_ID]]);
  });

  it('目標カロリーの行が無い人は target_kcal が null (失敗ではない)', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: { nickname: 'はなこ' }, nutritionTarget: null });

    const result = await fetchPhotoTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result).toEqual({ profile: { nickname: 'はなこ', target_kcal: null }, failures: [] });
  });

  it('片方が失敗しても、もう一方は使う。失敗は問い合わせごとに返す', async () => {
    const db = createFakeTourDb({
      userId: USER_ID,
      profile: { nickname: 'はなこ' },
      nutritionTarget: { daily_calories: 2000 },
    });
    db.failNext('nutrition_targets', pgError('42501', 'permission denied for table nutrition_targets'));

    const result = await fetchPhotoTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result.profile).toEqual({ nickname: 'はなこ', target_kcal: null });
    expect(result.failures).toEqual([
      { table: 'nutrition_targets', code: '42501', message: 'permission denied for table nutrition_targets' },
    ]);
  });

  it('両方が失敗すると、user_profiles → nutrition_targets の順に 2 件の failures を返す', async () => {
    const db = createFakeTourDb({ userId: USER_ID, profile: { nickname: 'はなこ' }, nutritionTarget: { daily_calories: 2000 } });
    db.failNext('user_profiles', pgError('57014', 'canceling statement due to statement timeout'));
    db.throwNext('nutrition_targets', new TypeError('Failed to fetch'));

    const result = await fetchPhotoTourProfile(db.supabase as unknown as TourProfileClient, USER_ID);

    expect(result.profile).toEqual(EMPTY_PHOTO_TOUR_PROFILE);
    expect(result.failures.map((f) => [f.table, f.code])).toEqual([
      ['user_profiles', '57014'],
      ['nutrition_targets', null],
    ]);
  });
});

describe('reportTourProfileFailures', () => {
  it('計測は共通 package のスキーマ (handson_tour_step_error) を満たし、サーバーログに原因を残す', () => {
    reportTourProfileFailures({
      step: 2,
      userId: USER_ID,
      failures: [{ table: 'user_profiles', code: '42703', message: 'column user_profiles.allergies does not exist' }],
    });

    expect(mocks.fireAnalytics).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mocks.fireAnalytics.mock.calls[0];
    expect(eventName).toBe('handson_tour_step_error');
    expect(payload).toMatchObject({
      user_id: USER_ID,
      platform: 'web',
      step: 2,
      sub_step: '2.1',
      error_code: 'profile_fetch_failed',
      error_message: 'user_profiles select failed (42703)',
    });
    // 開発時に fireAnalytics が行う検証と同じもの (不正な payload だと開発環境で例外になる)
    expect(() => HandsonTourEventSchemas.handson_tour_step_error.parse(payload)).not.toThrow();

    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
    expect(mocks.logToServer).toHaveBeenCalledWith('warn', 'handson-tour step2: user_profiles select failed', {
      step: 2,
      table: 'user_profiles',
      code: '42703',
      message: 'column user_profiles.allergies does not exist',
    });
  });

  it('nutrition_targets の失敗は別の error_code で、コードが無ければ括弧を付けない', () => {
    reportTourProfileFailures({
      step: 1,
      userId: USER_ID,
      failures: [{ table: 'nutrition_targets', code: null, message: 'Failed to fetch' }],
    });

    const [, payload] = mocks.fireAnalytics.mock.calls[0];
    expect(payload).toMatchObject({
      step: 1,
      sub_step: '1.1',
      error_code: 'nutrition_target_fetch_failed',
      error_message: 'nutrition_targets select failed',
    });
    expect(() => HandsonTourEventSchemas.handson_tour_step_error.parse(payload)).not.toThrow();
  });

  it('失敗が複数あれば 1 件ずつ記録し、無ければ何もしない', () => {
    reportTourProfileFailures({ step: 1, userId: USER_ID, failures: [] });
    expect(mocks.fireAnalytics).not.toHaveBeenCalled();
    expect(mocks.logToServer).not.toHaveBeenCalled();

    reportTourProfileFailures({
      step: 1,
      userId: USER_ID,
      failures: [
        { table: 'user_profiles', code: '57014', message: 'timeout' },
        { table: 'nutrition_targets', code: '42501', message: 'denied' },
      ],
    });
    expect(mocks.fireAnalytics).toHaveBeenCalledTimes(2);
    expect(mocks.logToServer).toHaveBeenCalledTimes(2);
  });

  it('計測が例外を投げても (開発時の検証エラーなど) 呼び出し元には伝えず、サーバーログは残す', () => {
    mocks.fireAnalytics.mockImplementation(() => {
      throw new Error('payload validation failed');
    });

    expect(() =>
      reportTourProfileFailures({
        step: 2,
        userId: USER_ID,
        failures: [{ table: 'user_profiles', code: '42703', message: 'x' }],
      }),
    ).not.toThrow();
    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
  });
});
