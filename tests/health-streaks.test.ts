import { describe, expect, it, vi } from 'vitest';
import { updateHealthStreak } from '../src/lib/health-streaks';

/**
 * #1048 F2-03: 過去日付のバックフィルで streak(連続記録)が破壊される不具合の回帰テスト。
 *
 * updateHealthStreak は supabase クライアントのメソッドチェーンを呼び出すだけなので、
 * ここでは `.from('health_streaks')` 呼び出しを最小限のスタブで再現し、
 * 呼び出し引数（update/insert に渡された値）を検証する。
 */

interface FakeStreakRow {
  id: string;
  user_id: string;
  streak_type: string;
  current_streak: number;
  longest_streak: number;
  total_records: number;
  last_activity_date: string | null;
  streak_start_date: string | null;
  achieved_badges: string[];
}

function createFakeSupabase(initialStreak: FakeStreakRow | null) {
  let streak = initialStreak;
  const updateCalls: any[] = [];
  const insertCalls: any[] = [];

  const supabase = {
    from(table: string) {
      expect(table).toBe('health_streaks');
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: streak, error: streak ? null : { code: 'PGRST116' } }),
            }),
          }),
        }),
        update: (payload: any) => {
          updateCalls.push(payload);
          if (streak) streak = { ...streak, ...payload };
          return {
            eq: async () => ({ data: null, error: null }),
          };
        },
        insert: (payload: any) => {
          insertCalls.push(payload);
          streak = { id: 'new-streak', ...payload };
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { supabase, updateCalls, insertCalls, getStreak: () => streak };
}

describe('updateHealthStreak', () => {
  it('creates a new streak row on first record', async () => {
    const { supabase, insertCalls } = createFakeSupabase(null);

    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      user_id: 'user-1',
      current_streak: 1,
      longest_streak: 1,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
      total_records: 1,
    });
  });

  it('increments the streak when the record continues from yesterday', async () => {
    const { supabase, updateCalls } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 5,
      longest_streak: 5,
      total_records: 5,
      last_activity_date: '2026-01-09',
      streak_start_date: '2026-01-05',
      achieved_badges: [],
    });

    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      current_streak: 6,
      longest_streak: 6,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-05',
      total_records: 6,
    });
  });

  it('resets the streak when there is a forward gap (missed days)', async () => {
    const { supabase, updateCalls } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 5,
      longest_streak: 5,
      total_records: 5,
      last_activity_date: '2026-01-01',
      streak_start_date: '2025-12-28',
      achieved_badges: [],
    });

    // 2026-01-10 は 2026-01-01 の翌日ではないため、通常のリセットロジックが働く
    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      current_streak: 1,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
    });
  });

  it('does not touch streak fields when the same day is recorded twice (no double count)', async () => {
    const { supabase, updateCalls, insertCalls } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 5,
      longest_streak: 5,
      total_records: 5,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-06',
      achieved_badges: [],
    });

    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('#1048 F2-03: backdating (past date) does not roll back an already-advanced streak', async () => {
    const { supabase, updateCalls, getStreak } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 30,
      longest_streak: 30,
      total_records: 30,
      last_activity_date: '2026-01-30',
      streak_start_date: '2026-01-01',
      achieved_badges: ['7_days', '14_days', '30_days'],
    });

    // 過去日 (2026-01-15) を後からバックフィル
    await updateHealthStreak(supabase, 'user-1', '2026-01-15');

    expect(updateCalls).toHaveLength(1);
    // total_records だけ加算され、streak 系は一切変更されない
    expect(updateCalls[0]).toEqual({
      total_records: 31,
      updated_at: expect.any(String),
    });

    const streak = getStreak();
    expect(streak?.current_streak).toBe(30);
    expect(streak?.longest_streak).toBe(30);
    expect(streak?.last_activity_date).toBe('2026-01-30');
    expect(streak?.streak_start_date).toBe('2026-01-01');
  });

  it('#1048 F2-03: backdating exactly one day before last_activity_date still preserves the streak', async () => {
    const { supabase, updateCalls } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 10,
      longest_streak: 10,
      total_records: 10,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-01',
      achieved_badges: ['7_days'],
    });

    // 2026-01-09 は last_activity_date (2026-01-10) より過去 → バックフィル扱い
    await updateHealthStreak(supabase, 'user-1', '2026-01-09');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual({
      total_records: 11,
      updated_at: expect.any(String),
    });
  });

  it('awards badge milestones on forward progress', async () => {
    const { supabase, updateCalls } = createFakeSupabase({
      id: 's1',
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 6,
      longest_streak: 6,
      total_records: 6,
      last_activity_date: '2026-01-09',
      streak_start_date: '2026-01-04',
      achieved_badges: [],
    });

    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(updateCalls[0].achieved_badges).toEqual(['7_days']);
  });
});
