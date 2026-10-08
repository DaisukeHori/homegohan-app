import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_STREAK_UPDATE_ATTEMPTS,
  computeNextStreak,
  updateHealthStreak,
  type StreakSnapshot,
} from '../src/lib/health-streaks';

// db-logger は実物だと app_logs へ書き込んでしまうため差し替え、呼び出しだけを検証する。
const { loggerError, withUser } = vi.hoisted(() => {
  const loggerError = vi.fn();
  const withUser = vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
  }));
  return { loggerError, withUser };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser,
  })),
}));

beforeEach(() => {
  loggerError.mockClear();
  withUser.mockClear();
});

/**
 * #1048 F2-03: 過去日付のバックフィルで streak(連続記録)が破壊される不具合の回帰テスト。
 * #1223: 同時リクエストで streak / total_records の加算が失われる(lost update)不具合の回帰テスト。
 *
 * updateHealthStreak は supabase クライアントのメソッドチェーンを呼び出すだけなので、
 * ここでは `.from('health_streaks')` を最小限のインメモリ DB で再現する。
 * UPDATE は WHERE 条件(.eq / .is)に一致した行だけを書き換えて、実際に更新された行を返す
 * (PostgREST と同じ。0 行なら空配列) ため、楽観的ロックの衝突を本物と同じ形で起こせる。
 */

interface FakeStreakRow {
  id: string;
  user_id: string;
  streak_type: string;
  current_streak: number | null;
  longest_streak: number | null;
  total_records: number | null;
  last_activity_date: string | null;
  streak_start_date: string | null;
  achieved_badges: string[] | null;
}

interface FakeDb {
  row: FakeStreakRow | null;
}

interface UpdateFilter {
  op: 'eq' | 'is';
  column: string;
  value: unknown;
}

interface UpdateCall {
  patch: Record<string, unknown>;
  filters: UpdateFilter[];
  /** WHERE 条件に一致して実際に書き換わったか */
  matched: boolean;
}

interface FakeHooks {
  /**
   * SELECT が行を返した直後(= 読み取りと書き込みの間)に呼ばれる。
   * 別リクエストが先にコミットした状況は、ここで db.row を書き換えて作る。readCount は 1 始まり。
   */
  afterRead?: (ctx: { readCount: number; db: FakeDb }) => void;
  readError?: unknown;
  updateError?: unknown;
  insertError?: unknown;
}

function streakRow(overrides: Partial<FakeStreakRow> = {}): FakeStreakRow {
  return {
    id: 's1',
    user_id: 'user-1',
    streak_type: 'daily_record',
    current_streak: 5,
    longest_streak: 5,
    total_records: 5,
    last_activity_date: '2026-01-09',
    streak_start_date: '2026-01-05',
    achieved_badges: [],
    ...overrides,
  };
}

function createFakeSupabase(initialStreak: FakeStreakRow | null, hooks: FakeHooks = {}) {
  const db: FakeDb = { row: initialStreak ? { ...initialStreak } : null };
  const updates: UpdateCall[] = [];
  /** 試行された UPDATE の payload (衝突して空振りしたものも含む) */
  const updateCalls: Record<string, unknown>[] = [];
  const insertCalls: Record<string, unknown>[] = [];
  let readCount = 0;

  function recordUpdate(call: UpdateCall) {
    updates.push(call);
    updateCalls.push(call.patch);
  }

  function runRead() {
    readCount += 1;
    if (hooks.readError) {
      return Promise.resolve({ data: null, error: hooks.readError });
    }
    // 先に読み取り結果を確定させてから hook を呼ぶ (hook による書き換えは「読んだ後」に起きる)
    const snapshot = db.row
      ? { ...db.row, achieved_badges: db.row.achieved_badges ? [...db.row.achieved_badges] : null }
      : null;
    hooks.afterRead?.({ readCount, db });
    // maybeSingle: 0 行でもエラーにせず data: null (PostgREST / supabase-js と同じ)
    return Promise.resolve({ data: snapshot, error: null });
  }

  function selectBuilder() {
    const builder = {
      eq: () => builder,
      maybeSingle: () => runRead(),
    };
    return builder;
  }

  function updateBuilder(patch: Record<string, unknown>) {
    const filters: UpdateFilter[] = [];
    let returning = false;

    const execute = () => {
      if (hooks.updateError) {
        recordUpdate({ patch, filters, matched: false });
        return { data: null, error: hooks.updateError };
      }
      const row = db.row;
      const matched =
        row !== null &&
        filters.every((filter) => {
          const actual = (row as unknown as Record<string, unknown>)[filter.column] ?? null;
          return actual === filter.value;
        });
      recordUpdate({ patch, filters, matched });
      if (matched && row) {
        db.row = { ...row, ...patch } as FakeStreakRow;
      }
      return { data: returning ? (matched && row ? [{ id: row.id }] : []) : null, error: null };
    };

    // await された時点で UPDATE を実行する (supabase-js の PostgrestBuilder と同じ)
    const builder = {
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value });
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push({ op: 'is', column, value });
        return builder;
      },
      select() {
        returning = true;
        return builder;
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  function runInsert(payload: Record<string, unknown>) {
    insertCalls.push(payload);
    if (hooks.insertError) {
      return { data: null, error: hooks.insertError };
    }
    if (db.row) {
      // UNIQUE(user_id, streak_type) 違反
      return {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "health_streaks_user_id_streak_type_key"',
        },
      };
    }
    db.row = { id: 'new-streak', ...payload } as FakeStreakRow;
    return { data: null, error: null };
  }

  const supabase = {
    from(table: string) {
      expect(table).toBe('health_streaks');
      return {
        select: () => selectBuilder(),
        update: (payload: Record<string, unknown>) => updateBuilder(payload),
        insert: (payload: Record<string, unknown>) => Promise.resolve(runInsert(payload)),
      };
    },
  };

  return {
    supabase,
    db,
    updates,
    updateCalls,
    insertCalls,
    readCount: () => readCount,
    getStreak: () => db.row,
  };
}

function snapshot(overrides: Partial<StreakSnapshot> = {}): StreakSnapshot {
  return {
    current_streak: 5,
    longest_streak: 5,
    last_activity_date: '2026-01-09',
    streak_start_date: '2026-01-05',
    achieved_badges: [],
    total_records: 5,
    ...overrides,
  };
}

describe('computeNextStreak (純粋関数)', () => {
  it('行がまだ無い(初回の記録)なら、1 日目として全列を返す', () => {
    expect(computeNextStreak(null, '2026-01-10')).toEqual({
      current_streak: 1,
      longest_streak: 1,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
      achieved_badges: [],
      total_records: 1,
    });
  });

  it('同じ日の記録は null (何も書かない)', () => {
    expect(computeNextStreak(snapshot({ last_activity_date: '2026-01-10' }), '2026-01-10')).toBeNull();
  });

  it('前日からの続きなら streak を 1 進め、開始日はそのまま', () => {
    expect(computeNextStreak(snapshot(), '2026-01-10')).toEqual({
      current_streak: 6,
      longest_streak: 6,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-05',
      achieved_badges: [],
      total_records: 6,
    });
  });

  it('月またぎ・年またぎでも前日判定ができる', () => {
    expect(
      computeNextStreak(snapshot({ last_activity_date: '2026-02-28' }), '2026-03-01')?.current_streak,
    ).toBe(6);
    expect(
      computeNextStreak(snapshot({ last_activity_date: '2025-12-31' }), '2026-01-01')?.current_streak,
    ).toBe(6);
  });

  it('日が空いたら streak を 1 に戻し、開始日を記録日にする (longest_streak は保つ)', () => {
    expect(
      computeNextStreak(
        snapshot({ current_streak: 5, longest_streak: 9, last_activity_date: '2026-01-01' }),
        '2026-01-10',
      ),
    ).toEqual({
      current_streak: 1,
      longest_streak: 9,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
      achieved_badges: [],
      total_records: 6,
    });
  });

  it('過去日付のバックフィルは total_records だけを +1 する (#1048 F2-03)', () => {
    expect(
      computeNextStreak(
        snapshot({ current_streak: 30, longest_streak: 30, total_records: 30, last_activity_date: '2026-01-30' }),
        '2026-01-15',
      ),
    ).toEqual({ total_records: 31 });
  });

  it.each([
    [7, '7_days'],
    [14, '14_days'],
    [30, '30_days'],
    [60, '60_days'],
    [100, '100_days'],
  ])('連続 %i 日に届いた記録で %s バッジが付く', (days, badge) => {
    const patch = computeNextStreak(
      snapshot({
        current_streak: days - 1,
        longest_streak: days - 1,
        total_records: days - 1,
        last_activity_date: '2026-06-09',
        achieved_badges: [],
      }),
      '2026-06-10',
    );

    expect(patch?.current_streak).toBe(days);
    expect(patch?.achieved_badges).toContain(badge);
  });

  it('届いていないマイルストーンのバッジは付かず、付与済みのバッジは重複しない', () => {
    const notYet = computeNextStreak(snapshot({ current_streak: 4 }), '2026-01-10');
    expect(notYet?.achieved_badges).toEqual([]);

    const already = computeNextStreak(
      snapshot({ current_streak: 7, longest_streak: 7, achieved_badges: ['7_days'] }),
      '2026-01-10',
    );
    expect(already?.current_streak).toBe(8);
    expect(already?.achieved_badges).toEqual(['7_days']);
  });

  it('NULL 許容列が NULL でも 0 / 空配列として計算する', () => {
    expect(
      computeNextStreak(
        {
          current_streak: null,
          longest_streak: null,
          last_activity_date: null,
          streak_start_date: null,
          achieved_badges: null,
          total_records: null,
        },
        '2026-01-10',
      ),
    ).toEqual({
      current_streak: 1,
      longest_streak: 1,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
      achieved_badges: [],
      total_records: 1,
    });
  });

  it('入力の行を書き換えない (achieved_badges を凍結しても例外にならない)', () => {
    const frozenBadges = Object.freeze(['7_days']) as unknown as string[];
    const input = Object.freeze(
      snapshot({ current_streak: 29, longest_streak: 29, achieved_badges: frozenBadges }),
    );

    // 29 日目 → 30 日目。7_days は付与済みなので 14_days / 30_days が足される
    const patch = computeNextStreak(input, '2026-01-10');

    expect(patch?.current_streak).toBe(30);
    expect(patch?.achieved_badges).toEqual(['7_days', '14_days', '30_days']);
    expect(frozenBadges).toEqual(['7_days']);
  });

  it('書き込みを返すときは必ず total_records を +1 する (楽観的ロックの版番号の不変条件)', () => {
    const cases: Array<[StreakSnapshot, string]> = [
      [snapshot({ total_records: 5 }), '2026-01-10'], // 前進
      [snapshot({ total_records: 5, last_activity_date: '2026-01-01' }), '2026-01-10'], // リセット
      [snapshot({ total_records: 5, last_activity_date: '2026-01-30' }), '2026-01-15'], // バックフィル
      [snapshot({ total_records: 0 }), '2026-01-10'],
      [snapshot({ total_records: null }), '2026-01-10'],
    ];

    for (const [input, recordDate] of cases) {
      const patch = computeNextStreak(input, recordDate);
      expect(patch).not.toBeNull();
      expect(patch?.total_records).toBe((input.total_records ?? 0) + 1);
    }
  });
});

describe('updateHealthStreak', () => {
  it('creates a new streak row on first record', async () => {
    const { supabase, insertCalls } = createFakeSupabase(null);

    const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(result).toEqual({ ok: true });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      user_id: 'user-1',
      streak_type: 'daily_record',
      current_streak: 1,
      longest_streak: 1,
      last_activity_date: '2026-01-10',
      streak_start_date: '2026-01-10',
      total_records: 1,
    });
  });

  it('increments the streak when the record continues from yesterday', async () => {
    const { supabase, updateCalls } = createFakeSupabase(streakRow());

    const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(result).toEqual({ ok: true });
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
    const { supabase, updateCalls } = createFakeSupabase(
      streakRow({ last_activity_date: '2026-01-01', streak_start_date: '2025-12-28' }),
    );

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
    const { supabase, updateCalls, insertCalls } = createFakeSupabase(
      streakRow({ last_activity_date: '2026-01-10', streak_start_date: '2026-01-06' }),
    );

    const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(result).toEqual({ ok: true });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('#1048 F2-03: backdating (past date) does not roll back an already-advanced streak', async () => {
    const { supabase, updateCalls, getStreak } = createFakeSupabase(
      streakRow({
        current_streak: 30,
        longest_streak: 30,
        total_records: 30,
        last_activity_date: '2026-01-30',
        streak_start_date: '2026-01-01',
        achieved_badges: ['7_days', '14_days', '30_days'],
      }),
    );

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
    const { supabase, updateCalls } = createFakeSupabase(
      streakRow({
        current_streak: 10,
        longest_streak: 10,
        total_records: 10,
        last_activity_date: '2026-01-10',
        streak_start_date: '2026-01-01',
        achieved_badges: ['7_days'],
      }),
    );

    // 2026-01-09 は last_activity_date (2026-01-10) より過去 → バックフィル扱い
    await updateHealthStreak(supabase, 'user-1', '2026-01-09');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual({
      total_records: 11,
      updated_at: expect.any(String),
    });
  });

  it('awards badge milestones on forward progress', async () => {
    const { supabase, updateCalls } = createFakeSupabase(
      streakRow({ current_streak: 6, longest_streak: 6, total_records: 6, streak_start_date: '2026-01-04' }),
    );

    await updateHealthStreak(supabase, 'user-1', '2026-01-10');

    expect(updateCalls[0].achieved_badges).toEqual(['7_days']);
  });

  describe('#1223: 楽観的ロック (compare-and-swap)', () => {
    it('UPDATE は「id」と「読み込んだ時点の total_records」を条件にする', async () => {
      const { supabase, updates } = createFakeSupabase(streakRow({ total_records: 5 }));

      await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(updates).toHaveLength(1);
      expect(updates[0].filters).toEqual([
        { op: 'eq', column: 'id', value: 's1' },
        { op: 'eq', column: 'total_records', value: 5 },
      ]);
      expect(updates[0].matched).toBe(true);
    });

    it('total_records が NULL の行は .is(null) で条件にし、1 件目として数える', async () => {
      const { supabase, updates, getStreak } = createFakeSupabase(
        streakRow({
          current_streak: null,
          longest_streak: null,
          total_records: null,
          last_activity_date: null,
          streak_start_date: null,
          achieved_badges: null,
        }),
      );

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toEqual({ ok: true });
      expect(updates).toHaveLength(1);
      expect(updates[0].filters).toEqual([
        { op: 'eq', column: 'id', value: 's1' },
        { op: 'is', column: 'total_records', value: null },
      ]);
      expect(updates[0].matched).toBe(true);
      expect(getStreak()).toMatchObject({
        current_streak: 1,
        longest_streak: 1,
        total_records: 1,
        last_activity_date: '2026-01-10',
      });
    });

    it('1 回目の UPDATE が他リクエストに先を越されて 0 行になっても、読み直して成功する', async () => {
      // 読み取りの後・書き込みの前に、別リクエストが 2026-01-10 の記録をコミットした状況
      const { supabase, updates, getStreak, readCount } = createFakeSupabase(streakRow(), {
        afterRead: ({ readCount: n, db }) => {
          if (n === 1 && db.row) {
            db.row = {
              ...db.row,
              current_streak: 6,
              longest_streak: 6,
              total_records: 6,
              last_activity_date: '2026-01-10',
            };
          }
        },
      });

      // こちらは 2026-01-11 の記録。古い行(last=01-09)から計算すると「日が空いた」と誤判定して 1 に戻ってしまう
      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-11');

      expect(result).toEqual({ ok: true });
      expect(readCount()).toBe(2);
      expect(updates).toHaveLength(2);
      // 1 回目: 古い版 (total_records=5) を条件にしたので空振り
      expect(updates[0].matched).toBe(false);
      expect(updates[0].filters).toContainEqual({ op: 'eq', column: 'total_records', value: 5 });
      expect(updates[0].patch).toMatchObject({ current_streak: 1 });
      // 2 回目: 読み直した版 (total_records=6) から計算し直して成功
      expect(updates[1].matched).toBe(true);
      expect(updates[1].filters).toContainEqual({ op: 'eq', column: 'total_records', value: 6 });
      expect(getStreak()).toMatchObject({
        current_streak: 7,
        longest_streak: 7,
        total_records: 7,
        last_activity_date: '2026-01-11',
        streak_start_date: '2026-01-05',
        achieved_badges: ['7_days'],
      });
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('先を越した相手が同じ日の記録だったら、読み直した結果は「同日は無視」で二重に数えない', async () => {
      const { supabase, updates, getStreak } = createFakeSupabase(streakRow(), {
        afterRead: ({ readCount: n, db }) => {
          if (n === 1 && db.row) {
            db.row = {
              ...db.row,
              current_streak: 6,
              longest_streak: 6,
              total_records: 6,
              last_activity_date: '2026-01-10',
            };
          }
        },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toEqual({ ok: true });
      // 空振りした 1 回目だけ。読み直した後は何も書かない
      expect(updates).toHaveLength(1);
      expect(updates[0].matched).toBe(false);
      expect(getStreak()).toMatchObject({ current_streak: 6, total_records: 6, last_activity_date: '2026-01-10' });
    });

    it('衝突が解消しないまま上限回数に達したら、例外ではなく { ok: false, reason: "conflict" } を返してログに残す', async () => {
      // 読むたびに別リクエストが先に書き込み続ける (常に total_records が進む)
      const { supabase, updates, insertCalls, readCount, getStreak } = createFakeSupabase(streakRow(), {
        afterRead: ({ db }) => {
          if (db.row) {
            db.row = { ...db.row, total_records: (db.row.total_records ?? 0) + 1 };
          }
        },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(readCount()).toBe(MAX_STREAK_UPDATE_ATTEMPTS);
      expect(updates).toHaveLength(MAX_STREAK_UPDATE_ATTEMPTS);
      expect(updates.every((update) => !update.matched)).toBe(true);
      expect(insertCalls).toHaveLength(0);
      // 自分の更新は 1 件も反映されていない (中途半端な書き込みが残らない)
      expect(getStreak()?.last_activity_date).toBe('2026-01-09');

      expect(withUser).toHaveBeenCalledWith('user-1');
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('health-streaks'),
        expect.any(Error),
        expect.objectContaining({ reason: 'conflict', record_date: '2026-01-10' }),
      );
    });

    it('INSERT が UNIQUE 違反 (23505) になったら、読み直して更新パスに入り、加算を失わない', async () => {
      // 読んだ時点では行が無かったが、INSERT の前に別リクエストが 2026-01-09 の初回記録を作った
      const { supabase, insertCalls, updates, getStreak, readCount } = createFakeSupabase(null, {
        afterRead: ({ readCount: n, db }) => {
          if (n === 1) {
            db.row = streakRow({
              id: 'created-by-other',
              current_streak: 1,
              longest_streak: 1,
              total_records: 1,
              last_activity_date: '2026-01-09',
              streak_start_date: '2026-01-09',
            });
          }
        },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toEqual({ ok: true });
      expect(insertCalls).toHaveLength(1);
      expect(readCount()).toBe(2);
      expect(updates).toHaveLength(1);
      expect(updates[0].matched).toBe(true);
      expect(updates[0].filters).toContainEqual({ op: 'eq', column: 'id', value: 'created-by-other' });
      expect(getStreak()).toMatchObject({
        current_streak: 2,
        longest_streak: 2,
        total_records: 2,
        last_activity_date: '2026-01-10',
        streak_start_date: '2026-01-09',
      });
      expect(loggerError).not.toHaveBeenCalled();
    });

    it('初回記録の二重送信 (同じ日) で INSERT が 23505 になっても、二重に数えない', async () => {
      const { supabase, updates, getStreak } = createFakeSupabase(null, {
        afterRead: ({ readCount: n, db }) => {
          if (n === 1) {
            db.row = streakRow({
              id: 'created-by-other',
              current_streak: 1,
              longest_streak: 1,
              total_records: 1,
              last_activity_date: '2026-01-10',
              streak_start_date: '2026-01-10',
            });
          }
        },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toEqual({ ok: true });
      expect(updates).toHaveLength(0);
      expect(getStreak()).toMatchObject({ current_streak: 1, total_records: 1 });
    });

    it('INSERT が 23505 のまま行も見えない状態が続いたら、上限回数で { ok: false, reason: "conflict" }', async () => {
      const { supabase, insertCalls, readCount } = createFakeSupabase(null, {
        insertError: { code: '23505', message: 'duplicate key value' },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(readCount()).toBe(MAX_STREAK_UPDATE_ATTEMPTS);
      expect(insertCalls).toHaveLength(MAX_STREAK_UPDATE_ATTEMPTS);
      expect(loggerError).toHaveBeenCalledTimes(1);
    });
  });

  describe('#1223: 同時リクエスト (lost update の回帰)', () => {
    it('連続する日の 2 リクエストが同時に来ても、両方が加算される', async () => {
      const { supabase, getStreak } = createFakeSupabase(streakRow());

      // 2 本とも同じ行 (last=01-09, total=5) を読んでから書き込みに進む
      const results = await Promise.all([
        updateHealthStreak(supabase, 'user-1', '2026-01-10'),
        updateHealthStreak(supabase, 'user-1', '2026-01-11'),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }]);
      // 修正前は片方の加算が消えて current_streak=1 / total_records=6 になっていた
      expect(getStreak()).toMatchObject({
        current_streak: 7,
        longest_streak: 7,
        total_records: 7,
        last_activity_date: '2026-01-11',
        streak_start_date: '2026-01-05',
        achieved_badges: ['7_days'],
      });
    });

    it('過去日のバックフィルが 2 本同時に来ても、total_records は 2 件分増える', async () => {
      const { supabase, getStreak } = createFakeSupabase(
        streakRow({
          current_streak: 30,
          longest_streak: 30,
          total_records: 30,
          last_activity_date: '2026-01-30',
          streak_start_date: '2026-01-01',
          achieved_badges: ['7_days', '14_days', '30_days'],
        }),
      );

      const results = await Promise.all([
        updateHealthStreak(supabase, 'user-1', '2026-01-15'),
        updateHealthStreak(supabase, 'user-1', '2026-01-16'),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(getStreak()).toMatchObject({
        current_streak: 30,
        longest_streak: 30,
        total_records: 32,
        last_activity_date: '2026-01-30',
      });
    });

    it('同じ日の二重送信が同時に来ても、1 日分しか数えない', async () => {
      const { supabase, updates, getStreak } = createFakeSupabase(streakRow());

      const results = await Promise.all([
        updateHealthStreak(supabase, 'user-1', '2026-01-10'),
        updateHealthStreak(supabase, 'user-1', '2026-01-10'),
        updateHealthStreak(supabase, 'user-1', '2026-01-10'),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      expect(updates.filter((update) => update.matched)).toHaveLength(1);
      expect(getStreak()).toMatchObject({ current_streak: 6, total_records: 6, last_activity_date: '2026-01-10' });
    });

    it('初回の記録が同時に来ても、行は 1 つで加算は失われない', async () => {
      const { supabase, getStreak, insertCalls } = createFakeSupabase(null);

      const results = await Promise.all([
        updateHealthStreak(supabase, 'user-1', '2026-01-10'),
        updateHealthStreak(supabase, 'user-1', '2026-01-11'),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }]);
      // 2 本目の INSERT は 23505 で弾かれ、読み直して更新パスに入る
      expect(insertCalls).toHaveLength(2);
      expect(getStreak()).toMatchObject({
        current_streak: 2,
        longest_streak: 2,
        total_records: 2,
        last_activity_date: '2026-01-11',
        streak_start_date: '2026-01-10',
      });
    });

    it('重なるリクエストが上限回数以内なら、すべて成功してバッジも付く', async () => {
      const writers = MAX_STREAK_UPDATE_ATTEMPTS;
      const { supabase, getStreak } = createFakeSupabase(
        streakRow({
          current_streak: 3,
          longest_streak: 3,
          total_records: 3,
          last_activity_date: '2026-01-09',
          streak_start_date: '2026-01-07',
        }),
      );

      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          updateHealthStreak(supabase, 'user-1', `2026-01-${String(10 + i).padStart(2, '0')}`),
        ),
      );

      expect(results.every((result) => result.ok)).toBe(true);
      const finalStreak = 3 + writers;
      expect(getStreak()).toMatchObject({
        current_streak: finalStreak,
        longest_streak: finalStreak,
        total_records: finalStreak,
        last_activity_date: `2026-01-${String(9 + writers).padStart(2, '0')}`,
        achieved_badges: finalStreak >= 7 ? ['7_days'] : [],
      });
    });

    it('上限より 1 本多く重なったら、はみ出した 1 本だけが conflict になり、他は壊れない', async () => {
      const writers = MAX_STREAK_UPDATE_ATTEMPTS + 1;
      const { supabase, getStreak } = createFakeSupabase(
        streakRow({
          current_streak: 3,
          longest_streak: 3,
          total_records: 3,
          last_activity_date: '2026-01-09',
          streak_start_date: '2026-01-07',
        }),
      );

      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          updateHealthStreak(supabase, 'user-1', `2026-01-${String(10 + i).padStart(2, '0')}`),
        ),
      );

      const failed = results.filter((result) => !result.ok);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ ok: false, reason: 'conflict' });
      // 成功した分だけが、欠けも二重もなく反映されている
      const succeeded = writers - 1;
      expect(getStreak()).toMatchObject({
        current_streak: 3 + succeeded,
        total_records: 3 + succeeded,
      });
      expect(loggerError).toHaveBeenCalledTimes(1);
    });
  });

  describe('#1223: DB エラーは握りつぶさず、結果で返してログに残す (例外は投げない)', () => {
    it('行の取得に失敗したら、INSERT / UPDATE へ進まず db_error を返す', async () => {
      const { supabase, insertCalls, updates } = createFakeSupabase(streakRow(), {
        readError: { code: '08006', message: 'connection failure' },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toMatchObject({ ok: false, reason: 'db_error' });
      expect(result.ok === false && result.message).toContain('connection failure');
      expect(insertCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('health-streaks'),
        expect.any(Error),
        expect.objectContaining({ reason: 'db_error', record_date: '2026-01-10' }),
      );
    });

    it('UPDATE がエラーになったら、リトライせず db_error を返す (二重加算を避ける)', async () => {
      const { supabase, updates, readCount } = createFakeSupabase(streakRow(), {
        updateError: { code: '42501', message: 'permission denied' },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toMatchObject({ ok: false, reason: 'db_error' });
      expect(readCount()).toBe(1);
      expect(updates).toHaveLength(1);
      expect(loggerError).toHaveBeenCalledTimes(1);
    });

    it('INSERT が 23505 以外のエラーになったら、リトライせず db_error を返す', async () => {
      const { supabase, insertCalls, readCount } = createFakeSupabase(null, {
        insertError: { code: '42501', message: 'new row violates row-level security policy' },
      });

      const result = await updateHealthStreak(supabase, 'user-1', '2026-01-10');

      expect(result).toMatchObject({ ok: false, reason: 'db_error' });
      expect(readCount()).toBe(1);
      expect(insertCalls).toHaveLength(1);
      expect(loggerError).toHaveBeenCalledTimes(1);
    });

    it('クライアントが例外を投げても reject せず db_error を返す', async () => {
      const supabase = {
        from() {
          throw new Error('network down');
        },
      };

      await expect(updateHealthStreak(supabase, 'user-1', '2026-01-10')).resolves.toMatchObject({
        ok: false,
        reason: 'db_error',
        message: 'network down',
      });
      expect(loggerError).toHaveBeenCalledTimes(1);
    });
  });
});
