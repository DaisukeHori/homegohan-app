/**
 * tests/api/onboarding-complete-route.test.ts
 *
 * Issue #1045 (F6-11): welcome 画面の「あとで設定する」は質問に一つも答えないまま
 * /api/onboarding/complete を呼ぶため、user_profiles 行がまだ存在しないと
 * .single() が 0 行エラーを返し 500 になっていた。
 * profile 不在時にデフォルト値で upsert してから完了処理を続行することを検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentClient: any;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentClient,
}));

vi.mock('@/lib/handson-tour/getStatus', () => ({
  getHandsonTourStatusInternal: vi.fn().mockResolvedValue({
    should_show: false,
    completed_at: null,
    skipped_at: null,
    reason: 'already_completed',
  }),
}));

import { POST } from '../../src/app/api/onboarding/complete/route';

function genericBuilder(finalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  builder.single = vi.fn().mockResolvedValue(finalResult);
  builder.insert = vi.fn().mockResolvedValue({ error: null });
  builder.update = vi.fn().mockReturnValue({ error: null });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

describe('#1045 F6-11: プロファイル不在時の /api/onboarding/complete', () => {
  it('user_profiles 行が存在しない場合、デフォルト値で upsert してから完了処理が成功する (200)', async () => {
    const upsertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'user-1',
            nickname: 'Guest',
            gender: 'unspecified',
            age_group: 'unspecified',
            onboarding_started_at: '2026-07-10T00:00:00.000Z',
            nutrition_goal: null,
            performance_profile: null,
          },
          error: null,
        }),
      }),
    });

    let userProfilesCall = 0;

    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn((table: string) => {
        if (table === 'user_profiles') {
          userProfilesCall += 1;
          if (userProfilesCall === 1) {
            // 初回 fetch: 行が存在しない (maybeSingle → data:null)
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            };
          }
          if (userProfilesCall === 2) {
            // #1045: profile 不在時の upsert
            return { upsert: upsertMock };
          }
          // 完了フラグ更新
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        // nutrition_targets 等その他のテーブルは無害なデフォルトを返す
        return genericBuilder();
      }),
    };

    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // デフォルト profile の必須カラムを満たした upsert が行われたことを確認
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-1',
        nickname: 'Guest',
        gender: 'unspecified',
        age_group: 'unspecified',
      }),
    );
  });

  it('user_profiles 行が既に存在する場合は upsert せず既存プロファイルで完了処理する', async () => {
    const existingProfile = {
      id: 'user-1',
      nickname: 'たろう',
      gender: 'male',
      age_group: '30s',
      nutrition_goal: 'maintain',
      performance_profile: null,
      exercise_frequency: 3,
      exercise_duration_per_session: 30,
    };

    let userProfilesCall = 0;
    const upsertMock = vi.fn();

    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn((table: string) => {
        if (table === 'user_profiles') {
          userProfilesCall += 1;
          if (userProfilesCall === 1) {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: existingProfile, error: null }),
                }),
              }),
            };
          }
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
            upsert: upsertMock,
          };
        }
        return genericBuilder();
      }),
    };

    const res = await POST();
    expect(res.status).toBe(200);
    // 既存行があるため #1045 で追加した upsert 分岐は呼ばれない
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('profile fetch 自体が DB エラーの場合は 500 を返す', async () => {
    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection error' } }),
          }),
        }),
      })),
    };

    const res = await POST();
    expect(res.status).toBe(500);
  });
});
