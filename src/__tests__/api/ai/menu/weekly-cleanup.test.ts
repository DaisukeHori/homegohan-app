/**
 * src/__tests__/api/ai/menu/weekly-cleanup.test.ts
 *
 * #1042: stale sweeper (weekly/cleanup) が waitUntil 消失等で生成コールバックが
 * 実行されず stuck になったリクエストを failed 化するだけで、削除済み献立の
 * スナップショット (generated_data.snapshot) を復元しない問題の修正確認。
 *
 * - stuck リクエストが無い場合は復元を呼ばないこと
 * - stuck リクエストのうち snapshot を持つものだけ復元し、結果を集計して response に含めること
 * - failed への更新自体が失敗した場合は (その行の) 復元を呼ばず 500 を返すこと
 *
 * #1203: 復元が打ち切られないよう maxDuration を明示していること、および
 * 複数の stuck リクエストの復元を直列に実行すること
 * (並列だと、同じスロットを指す snapshot が「空き」を同時に判定して二重復元してしまう)。
 *
 * #1494: 週間ページを開くたびの cleanup が、cron の順番待ち (queued) の行と生成中の行を、作成から 5 分で failed にしていた
 * (queued は積んだ時点で AI の 1 回を数えている (#1149) ので、数えた 1 回が成果なしで消えていた)。
 * - queued の行は、作成からどれだけたっていても触らない (読む対象にも含めない)
 * - processing の行は、作成時刻ではなく生存信号 (GREATEST(worker_acquired_at, updated_at)・無ければ updated_at) から
 *   WEEKLY_MENU_REQUEST_STALE_MINUTES (20 分) 進まなかった行だけを failed にする
 * - 読んでから書くまでに進んだ行 (生存信号・状態が変わった行) は書き換えない (比較つきの更新)
 * - 行ごとの更新が途中の行で失敗しても抜けずに残りの行へ進み、failed にできた行の復元を済ませてから 500 を返す
 *   (途中で抜けると、failed にした行は以後どの route にも拾われず、消した献立が戻らない)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { WEEKLY_MENU_REQUEST_STALE_MESSAGE } from '@/lib/weekly-menu-request-error';
import { WEEKLY_MENU_REQUEST_STALE_MINUTES } from '@/lib/weekly-menu-request-stale';

/** テストの「今」(固定) */
const NOW_MS = Date.parse('2026-10-11T03:00:00.000Z');
const MIN = 60 * 1000;
/** 今から minutes 分前の時刻 (PostgREST が返す形) */
const ago = (minutes: number) => new Date(NOW_MS - minutes * MIN).toISOString();

const mockGetUser = vi.fn();

type Row = {
  id: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  worker_acquired_at: string | null;
};

// 利用者のクライアント: from('weekly_menu_requests').select(...).eq('user_id', ...).in('status', [...])
const fetchResultQueue: Array<{ data: Row[] | null; error: unknown }> = [];
const mockSelectIn = vi.fn((..._args: unknown[]) => Promise.resolve(fetchResultQueue.shift() ?? { data: [], error: null }));
const mockSelectEq = vi.fn((..._args: unknown[]) => ({ in: mockSelectIn }));
const mockSelect = vi.fn((..._args: unknown[]) => ({ eq: mockSelectEq }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { select: mockSelect };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

// service role のクライアント: 行ごとの比較つきの更新
//   from('weekly_menu_requests').update(payload).eq(...).eq(...).eq(...).(eq|is)(...).(eq|is)(...).select('id, generated_data')
// 呼ばれたフィルタを記録し、select の戻り値は updateResultQueue から返す
type UpdateCall = { payload: Record<string, unknown>; filters: Array<[string, string, unknown]>; returning?: string };
const updateCalls: UpdateCall[] = [];
const updateResultQueue: Array<{ data: Array<{ id: string; generated_data: unknown }> | null; error: unknown }> = [];

function makeUpdateBuilder(call: UpdateCall) {
  const builder = {
    eq: (column: string, value: unknown) => {
      call.filters.push(['eq', column, value]);
      return builder;
    },
    is: (column: string, value: unknown) => {
      call.filters.push(['is', column, value]);
      return builder;
    },
    select: (columns: string) => {
      call.returning = columns;
      return Promise.resolve(updateResultQueue.shift() ?? { data: [], error: null });
    },
  };
  return builder;
}

const mockUpdate = vi.fn((payload: Record<string, unknown>) => {
  const call: UpdateCall = { payload, filters: [] };
  updateCalls.push(call);
  return makeUpdateBuilder(call);
});

// AI のキューへの書き込みは service role のクライアント (getAiQueueWriter → getSupabaseAdmin) で行う (#1465)
const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { update: mockUpdate };
  }
  throw new Error(`Unexpected table in test (admin): ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
  getSupabaseAdmin: vi.fn(() => ({ from: mockAdminFrom })),
}));

const mockRestorePlannedMealsSnapshot = vi.fn(async (..._args: unknown[]) => ({ restored: 0, skipped: 0, failed: 0 }));
vi.mock('@/lib/planned-meals-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planned-meals-snapshot')>();
  return {
    ...actual,
    restorePlannedMealsSnapshot: mockRestorePlannedMealsSnapshot,
  };
});

const { POST, maxDuration } = await import('@/app/api/ai/menu/weekly/cleanup/route');

const user = { id: 'user-1' };

/** 止まった processing の行 (キューを経由しない行。生存信号 = updated_at が 30 分前) */
function stuckProcessing(id: string): Row {
  return { id, status: 'processing', created_at: ago(60), updated_at: ago(30), worker_acquired_at: null };
}

/** 更新のフィルタから、指定した列の条件を取り出す */
function filterOf(call: UpdateCall, column: string) {
  return call.filters.filter(([, c]) => c === column);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  fetchResultQueue.length = 0;
  updateResultQueue.length = 0;
  updateCalls.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/ai/menu/weekly/cleanup', () => {
  it('stuck リクエストが無い場合は復元を呼ばず「進まなくなった献立の生成はありません」を返す', async () => {
    fetchResultQueue.push({ data: [], error: null });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.message).toBe('進まなくなった献立の生成はありません');
    expect(json.cleaned).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot を持つ stuck リクエストのみ復元し、結果を集計して返す', async () => {
    const snapshotRowA = { id: 'meal-a', daily_meal_id: 'day-a', meal_type: 'breakfast' };
    fetchResultQueue.push({
      data: [
        stuckProcessing('req-1'),
        { id: 'req-2', status: 'pending', created_at: ago(60), updated_at: ago(30), worker_acquired_at: null },
      ],
      error: null,
    });
    updateResultQueue.push({ data: [{ id: 'req-1', generated_data: { snapshot: [snapshotRowA] } }], error: null });
    updateResultQueue.push({ data: [{ id: 'req-2', generated_data: null }], error: null });
    mockRestorePlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.message).toBe('進まなくなった献立の生成を片付けました');
    expect(json.cleaned).toBe(2);
    expect(json.ids).toEqual(['req-1', 'req-2']);
    expect(json.restoredMeals).toBe(1);
    expect(json.skippedMeals).toBe(0);
    expect(json.failedMeals).toBe(0);

    // snapshot を持つ req-1 分のみ復元が呼ばれる
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(mockSupabase, [snapshotRowA]);

    // failed への更新は service role で、本人の行に絞って、行ごとに行う (#1465・#1494)
    expect(mockAdminFrom).toHaveBeenCalledWith('weekly_menu_requests');
    expect(updateCalls).toHaveLength(2);
    for (const [index, call] of updateCalls.entries()) {
      expect(call.payload).toEqual({
        status: 'failed',
        error_message: WEEKLY_MENU_REQUEST_STALE_MESSAGE,
        updated_at: new Date(NOW_MS).toISOString(),
      });
      expect(filterOf(call, 'id')).toEqual([['eq', 'id', `req-${index + 1}`]]);
      expect(filterOf(call, 'user_id')).toEqual([['eq', 'user_id', user.id]]);
      // 実際に書き換えた行の generated_data を受け取って復元に使う (生成中に大きくなる列を最初の読み取りでは読まない。#1042)
      expect(call.returning).toBe('id, generated_data');
    }
  });

  it('failed への更新自体が失敗した場合は復元を呼ばず 500 を返す', async () => {
    fetchResultQueue.push({ data: [stuckProcessing('req-1')], error: null });
    updateResultQueue.push({ data: null, error: { message: 'update failed' } });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(500);
    // DB の生のエラー文は本文に出さない (#1172)
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('読み取り自体が失敗した場合は更新も復元もせず 500 を返す', async () => {
    fetchResultQueue.push({ data: null, error: { message: 'select failed' } });

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('複数の stuck リクエストの復元は直列に実行し、結果を合算して返す (#1203)', async () => {
    // 同じスロット (day-1 の朝食) を指す 2 件の snapshot: 並列に復元すると二重に復元されてしまう
    const snapshotA = [{ id: 'meal-a', daily_meal_id: 'day-1', meal_type: 'breakfast' }];
    const snapshotB = [{ id: 'meal-b', daily_meal_id: 'day-1', meal_type: 'breakfast' }];
    fetchResultQueue.push({ data: [stuckProcessing('req-1'), stuckProcessing('req-2')], error: null });
    updateResultQueue.push({ data: [{ id: 'req-1', generated_data: { snapshot: snapshotA } }], error: null });
    updateResultQueue.push({ data: [{ id: 'req-2', generated_data: { snapshot: snapshotB } }], error: null });

    let inFlight = 0;
    let maxInFlight = 0;
    const slowRestore = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 何度か制御を手放す (並列に呼ばれていれば、このあいだにもう 1 件が始まる)
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { restored: 1, skipped: 1, failed: 1 };
    };
    mockRestorePlannedMealsSnapshot.mockImplementationOnce(slowRestore).mockImplementationOnce(slowRestore);

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(2);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenNthCalledWith(1, mockSupabase, snapshotA);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenNthCalledWith(2, mockSupabase, snapshotB);
    // 同時に実行中の復元は常に 1 件以下
    expect(maxInFlight).toBe(1);
    expect(json.restoredMeals).toBe(2);
    expect(json.skippedMeals).toBe(2);
    expect(json.failedMeals).toBe(2);
  });

  it('復元が打ち切られないよう maxDuration を明示している (#1203)', () => {
    expect(maxDuration).toBe(60);
  });

  describe('#1494: 止まった行の判定 (queued は触らない・生存信号から 20 分)', () => {
    it('読む対象は pending / processing だけで、queued を含めない', async () => {
      fetchResultQueue.push({ data: [], error: null });

      await POST();

      expect(mockSelectEq).toHaveBeenCalledWith('user_id', user.id);
      expect(mockSelectIn).toHaveBeenCalledTimes(1);
      const [column, statuses] = mockSelectIn.mock.calls[0] as [string, string[]];
      expect(column).toBe('status');
      expect([...statuses].sort()).toEqual(['pending', 'processing']);
      expect(statuses).not.toContain('queued');
      // 生存信号の判定に使う列を読む (generated_data は読まない)
      expect(mockSelect).toHaveBeenCalledWith('id, status, created_at, updated_at, worker_acquired_at');
    });

    it('作成から 6 分たった queued の行は failed にならない (以前は作成から 5 分で failed にしていた)', async () => {
      // 読み取りは status で絞っているので本来は返らないが、返ってきても判定で落とす (二重の守り)
      fetchResultQueue.push({
        data: [{ id: 'queued-6', status: 'queued', created_at: ago(6), updated_at: ago(6), worker_acquired_at: null }],
        error: null,
      });

      const res = await POST();
      const json = await res.json();

      expect(json.cleaned).toBe(0);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('作成から 60 分たった (しきい値を超えて待つ) queued の行も failed にならない', async () => {
      fetchResultQueue.push({
        data: [{ id: 'queued-60', status: 'queued', created_at: ago(60), updated_at: ago(60), worker_acquired_at: null }],
        error: null,
      });

      const res = await POST();
      const json = await res.json();

      expect(json.cleaned).toBe(0);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('作成は 60 分前でも、生存信号が新しい processing の行は failed にしない', async () => {
      fetchResultQueue.push({
        data: [
          // キューを経由しない行: 生存信号 = updated_at (1 分前に進捗)
          { id: 'alive-direct', status: 'processing', created_at: ago(60), updated_at: ago(1), worker_acquired_at: null },
          // キューが取った行: 進捗 (updated_at) が新しい
          { id: 'alive-queue-progress', status: 'processing', created_at: ago(60), updated_at: ago(2), worker_acquired_at: ago(40) },
          // キューが取り直した直後の行: updated_at は古いが worker_acquired_at が新しい (GREATEST の判定)
          { id: 'alive-queue-reclaimed', status: 'processing', created_at: ago(60), updated_at: ago(30), worker_acquired_at: ago(1) },
        ],
        error: null,
      });

      const res = await POST();
      const json = await res.json();

      expect(json.cleaned).toBe(0);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('しきい値ちょうどまでは触らず、しきい値を超えて止まった行だけを failed にする', async () => {
      const justUnder = WEEKLY_MENU_REQUEST_STALE_MINUTES - 1;
      const justOver = WEEKLY_MENU_REQUEST_STALE_MINUTES + 1;
      fetchResultQueue.push({
        data: [
          { id: 'under', status: 'processing', created_at: ago(60), updated_at: ago(justUnder), worker_acquired_at: null },
          { id: 'exact', status: 'processing', created_at: ago(60), updated_at: ago(WEEKLY_MENU_REQUEST_STALE_MINUTES), worker_acquired_at: null },
          { id: 'over-direct', status: 'processing', created_at: ago(60), updated_at: ago(justOver), worker_acquired_at: null },
          { id: 'over-queue', status: 'processing', created_at: ago(60), updated_at: ago(justOver + 5), worker_acquired_at: ago(justOver) },
        ],
        error: null,
      });
      updateResultQueue.push({ data: [{ id: 'over-direct', generated_data: null }], error: null });
      updateResultQueue.push({ data: [{ id: 'over-queue', generated_data: null }], error: null });

      const res = await POST();
      const json = await res.json();

      expect(json.cleaned).toBe(2);
      expect(json.ids).toEqual(['over-direct', 'over-queue']);
      expect(updateCalls.map((call) => filterOf(call, 'id')[0]?.[2])).toEqual(['over-direct', 'over-queue']);
    });

    it('読んだときの状態・生存信号と一致する行だけを書き換える (比較つきの更新。NULL は .is で比べる)', async () => {
      const direct = stuckProcessing('req-direct');
      const queue: Row = { id: 'req-queue', status: 'processing', created_at: ago(90), updated_at: null, worker_acquired_at: ago(45) };
      fetchResultQueue.push({ data: [direct, queue], error: null });
      updateResultQueue.push({ data: [{ id: 'req-direct', generated_data: null }], error: null });
      updateResultQueue.push({ data: [{ id: 'req-queue', generated_data: null }], error: null });

      await POST();

      expect(updateCalls).toHaveLength(2);
      const [directCall, queueCall] = updateCalls;
      expect(filterOf(directCall, 'status')).toEqual([['eq', 'status', 'processing']]);
      expect(filterOf(directCall, 'updated_at')).toEqual([['eq', 'updated_at', direct.updated_at]]);
      expect(filterOf(directCall, 'worker_acquired_at')).toEqual([['is', 'worker_acquired_at', null]]);
      expect(filterOf(queueCall, 'status')).toEqual([['eq', 'status', 'processing']]);
      expect(filterOf(queueCall, 'updated_at')).toEqual([['is', 'updated_at', null]]);
      expect(filterOf(queueCall, 'worker_acquired_at')).toEqual([['eq', 'worker_acquired_at', queue.worker_acquired_at]]);
    });

    it('読んでから書くまでに進んだ行 (比較つきの更新が 0 行) は数えず、復元もしない', async () => {
      fetchResultQueue.push({ data: [stuckProcessing('raced'), stuckProcessing('stuck')], error: null });
      // raced: 書く前に Edge Function が進捗を書いた (updated_at が変わった) ので、比較つきの更新が 0 行
      updateResultQueue.push({ data: [], error: null });
      updateResultQueue.push({
        data: [{ id: 'stuck', generated_data: { snapshot: [{ id: 'm', daily_meal_id: 'd', meal_type: 'lunch' }] } }],
        error: null,
      });

      const res = await POST();
      const json = await res.json();

      expect(json.cleaned).toBe(1);
      expect(json.ids).toEqual(['stuck']);
      expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    });

    it('すべての行が読んでから書くまでに進んだときは「進まなくなった献立の生成はありません」を返す', async () => {
      fetchResultQueue.push({ data: [stuckProcessing('raced')], error: null });
      updateResultQueue.push({ data: [], error: null });

      const res = await POST();
      const json = await res.json();

      expect(json.message).toBe('進まなくなった献立の生成はありません');
      expect(json.cleaned).toBe(0);
      expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('#1494 R1: 行ごとの更新が途中の行で失敗したとき', () => {
    const snapshotOf = (mealId: string) => [{ id: mealId, daily_meal_id: `day-${mealId}`, meal_type: 'dinner' }];

    it('1 件目を failed にできて 2 件目の更新が失敗したら、1 件目の復元を済ませてから 500 を返す', async () => {
      fetchResultQueue.push({ data: [stuckProcessing('req-1'), stuckProcessing('req-2')], error: null });
      // req-1 は failed にでき、スナップショットを持つ
      updateResultQueue.push({ data: [{ id: 'req-1', generated_data: { snapshot: snapshotOf('meal-1') } }], error: null });
      // req-2 の更新は一時的な DB のエラー
      updateResultQueue.push({ data: null, error: { message: 'temporary failure' } });
      mockRestorePlannedMealsSnapshot.mockResolvedValueOnce({ restored: 1, skipped: 0, failed: 0 });

      const res = await POST();
      const json = await res.json();

      // failed にした req-1 の献立は、このときに戻す (以後どの route も failed の行を拾わないため)
      expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
      expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(mockSupabase, snapshotOf('meal-1'));
      // 更新の失敗は 500 で知らせる (DB の生のエラー文は本文に出さない。#1172)
      expect(res.status).toBe(500);
      expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
      expect(updateCalls.map((call) => filterOf(call, 'id')[0]?.[2])).toEqual(['req-1', 'req-2']);
    });

    it('1 件目の更新が失敗しても抜けずに 2 件目を更新し、failed にできた 2 件目の復元を済ませてから 500 を返す', async () => {
      fetchResultQueue.push({ data: [stuckProcessing('req-1'), stuckProcessing('req-2')], error: null });
      updateResultQueue.push({ data: null, error: { message: 'temporary failure' } });
      updateResultQueue.push({ data: [{ id: 'req-2', generated_data: { snapshot: snapshotOf('meal-2') } }], error: null });

      const res = await POST();

      expect(updateCalls.map((call) => filterOf(call, 'id')[0]?.[2])).toEqual(['req-1', 'req-2']);
      // 更新に失敗した req-1 (書き換わっていない) は復元せず、failed にできた req-2 だけを復元する
      expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
      expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(mockSupabase, snapshotOf('meal-2'));
      expect(res.status).toBe(500);
    });

    it('どの行の更新も失敗したときは復元を呼ばず 500 を返す', async () => {
      fetchResultQueue.push({ data: [stuckProcessing('req-1'), stuckProcessing('req-2')], error: null });
      updateResultQueue.push({ data: null, error: { message: 'temporary failure' } });
      updateResultQueue.push({ data: null, error: { message: 'temporary failure' } });

      const res = await POST();

      expect(updateCalls).toHaveLength(2);
      expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
      expect(res.status).toBe(500);
    });
  });
});
