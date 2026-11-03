// @vitest-environment node
/**
 * #2206 G4 プロフィールの完成度の計算し直しを、読んだときの完成度のままの行にだけ書く (src/lib/profile-completeness.ts)
 *
 * 問題 (直す前):
 *   refreshProfileCompleteness / syncProfileCompletenessOfRow は行を読んで計算し、条件なしで profile_completeness を書いた。
 *   読んでから書くまでに別の書き手 (PUT /api/profile など) が欄を書いて計算し直すと、その新しい完成度を、
 *   古い行から数えた値で上書きしえた。
 *
 * 直したあと (このテストが固定する):
 *   - 書くときは読んだときの完成度のままの行にだけ書く (eq('profile_completeness', 読んだ値)。読んだ値が null なら is null)
 *   - 0 行 (別の書き手が先に完成度を書いた) なら、今の行を読み直して数え直す
 *   - 書けたら、書いた後の行 (書いた時点の全部の欄) から数え直し、違えば (読んでから書くまでに欄が書き換わっていた) もう一度書く
 *   - PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS 回で書けなければ諦める (error)
 *
 * あわせて、モバイルのオンボーディングの途中保存が呼ぶ POST /api/profile/completeness (計算し直すだけの route) の応答を固定する
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeDb = vi.hoisted(() => ({ client: null as null | Record<string, unknown>, user: { id: 'user-1' } as { id: string } | null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    ...routeDb.client,
    auth: { getUser: async () => ({ data: { user: routeDb.user }, error: null }) },
  }),
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ ...logger, withUser: () => logger }), generateRequestId: () => 'request-1' }));

import {
  PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS,
  ProfileCompletenessWriteExhaustedError,
  profileCompletenessOfRow,
  refreshProfileCompleteness,
  syncProfileCompletenessOfRow,
} from '@/lib/profile-completeness';
import type { DbUserProfile } from '@/types/database';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';
import { POST as postProfileCompleteness } from '@/app/api/profile/completeness/route';
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

const USER_ID = 'user-1';
const HEIGHT_CM = 170;
const WEIGHT_KG = 62.5;
/** 計算し直す前の行に入っていた完成度 (古い値) */
const STALE_COMPLETENESS = 10;
/** 別の書き手が書き続ける完成度の基点 (計算した値 (名前・性別・身長の 12) と重ならない値) */
const OTHER_WRITER_COMPLETENESS_BASE = 50;
/** DB の失敗 */
const DB_FAILURE = { message: 'db error', code: 'XX000' };

/** 名前・性別だけの行 (ほかの欄は null) */
const BASE_ROW: Partial<DbUserProfile> = {
  id: USER_ID,
  nickname: 'ほり',
  gender: 'female',
  age: null,
  height: null,
  weight: null,
  profile_completeness: STALE_COMPLETENESS,
};

/** eq / is の条件 (列 → 値) */
function filtersOf(query: RecordedQuery): Array<{ column: string; value: unknown }> {
  return query.calls
    .filter((call) => call.method === 'eq' || call.method === 'is')
    .map((call) => ({ column: String(call.args[0]), value: call.args[1] }));
}

/**
 * user_profiles の 1 行をまねる。update は eq / is の条件に合うときだけ書き、書けた行を返す (合わなければ null = 0 行)。
 * select は今の行を返す。beforeCompletenessWrite は完成度の書き込みが届いたときに (書く前に) 呼ばれ、
 * 同時の別の書き手の書き込みをまねる
 */
function useProfileTable(initial: Partial<DbUserProfile>, beforeCompletenessWrite: (row: Record<string, unknown>, attempt: number) => void = () => {}) {
  const row: Record<string, unknown> = { ...initial };
  let completenessWrites = 0;
  const db = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    if (query.table !== 'user_profiles') throw new Error(`unexpected table: ${query.table}`);
    if (firstMethodOf(query) === 'update') {
      const values = query.calls[0].args[0] as Record<string, unknown>;
      if ('profile_completeness' in values) {
        completenessWrites += 1;
        beforeCompletenessWrite(row, completenessWrites);
      }
      const matches = filtersOf(query).every(({ column, value }) => (row[column] ?? null) === value);
      if (!matches) return { data: null };
      Object.assign(row, values);
      return { data: { ...row } };
    }
    return { data: { ...row } };
  });
  return { db, row, completenessWrites: () => completenessWrites };
}

/** 完成度の書き込み (update({ profile_completeness })) の問い合わせ */
function completenessWriteQueries(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (query) => firstMethodOf(query) === 'update' && 'profile_completeness' in (query.calls[0].args[0] as Record<string, unknown>),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  routeDb.user = { id: USER_ID };
});

describe('完成度は読んだときの完成度のままの行にだけ書く (#2206 G4)', () => {
  it('書き込みに読んだときの完成度の条件が付く (本人の行・読んだ値)', async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM };
    const { db, row } = useProfileTable(rowAfter);

    const outcome = await refreshProfileCompleteness(db.client as never, USER_ID);

    const expected = profileCompletenessOfRow(rowAfter);
    expect(outcome).toEqual({ status: 'updated', completeness: expected });
    expect(row.profile_completeness).toBe(expected);
    const [write] = completenessWriteQueries(db.queries);
    expect(write.calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', USER_ID] },
        { method: 'eq', args: ['profile_completeness', STALE_COMPLETENESS] },
      ]),
    );
  });

  it('読んだときの完成度が null なら is null を条件にする', async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM, profile_completeness: null };
    const { db, row } = useProfileTable(rowAfter);

    await refreshProfileCompleteness(db.client as never, USER_ID);

    const [write] = completenessWriteQueries(db.queries);
    expect(write.calls).toEqual(expect.arrayContaining([{ method: 'is', args: ['profile_completeness', null] }]));
    expect(row.profile_completeness).toBe(profileCompletenessOfRow(rowAfter));
  });

  it('読んでから書くまでに別の書き手 (PUT) が欄と完成度を書いたら、古い行から数えた値で上書きしない', async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM };
    // 別の書き手: 体重を書き、書いた後の行から数えた完成度を書く (PUT /api/profile と同じ)
    const { db, row } = useProfileTable(rowAfter, (current, attempt) => {
      if (attempt !== 1) return;
      current.weight = WEIGHT_KG;
      current.profile_completeness = profileCompletenessOfRow({ ...current } as Partial<DbUserProfile>);
    });
    const latest = profileCompletenessOfRow({ ...rowAfter, weight: WEIGHT_KG });
    const fromStaleRead = profileCompletenessOfRow(rowAfter);
    expect(latest).not.toBe(fromStaleRead);

    const outcome = await refreshProfileCompleteness(db.client as never, USER_ID);

    expect(row.profile_completeness).toBe(latest);
    // 0 行だったので読み直し、今の行の完成度がすでに正しいので書かない
    expect(outcome).toEqual({ status: 'unchanged', completeness: latest });
    expect(completenessWriteQueries(db.queries)).toHaveLength(1);
  });

  it('読んでから書くまでに欄だけが書き換わった (完成度はまだ古い) ときは、書いた後の行から数え直してもう一度書く', async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM };
    // 別の書き手: 体重を書いただけ (その書き手の計算し直しはまだ)
    const { db, row } = useProfileTable(rowAfter, (current, attempt) => {
      if (attempt === 1) current.weight = WEIGHT_KG;
    });
    const latest = profileCompletenessOfRow({ ...rowAfter, weight: WEIGHT_KG });

    const outcome = await refreshProfileCompleteness(db.client as never, USER_ID);

    expect(row.profile_completeness).toBe(latest);
    expect(outcome).toEqual({ status: 'updated', completeness: latest });
    const writes = completenessWriteQueries(db.queries);
    expect(writes).toHaveLength(2);
    // 2 回目は 1 回目に書いた値を条件にする
    expect(writes[1].calls).toEqual(
      expect.arrayContaining([{ method: 'eq', args: ['profile_completeness', profileCompletenessOfRow(rowAfter)] }]),
    );
  });

  it('syncProfileCompletenessOfRow (PUT の書いた後の行) も、そのあいだに完成度が書かれていたら上書きしない', async () => {
    const putRow = { ...BASE_ROW, height: HEIGHT_CM };
    const { db, row } = useProfileTable(putRow, (current, attempt) => {
      if (attempt !== 1) return;
      current.weight = WEIGHT_KG;
      current.profile_completeness = profileCompletenessOfRow({ ...current } as Partial<DbUserProfile>);
    });
    const latest = profileCompletenessOfRow({ ...putRow, weight: WEIGHT_KG });

    const synced = await syncProfileCompletenessOfRow(db.client as never, USER_ID, putRow);

    expect(row.profile_completeness).toBe(latest);
    expect(synced.outcome).toEqual({ status: 'unchanged', completeness: latest });
    expect(synced.row.profile_completeness).toBe(latest);
  });

  it(`書くたびに別の書き手が完成度を書き換え続けたら、${PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS} 回で諦める (error。例外は投げない)`, async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM };
    const { db, row } = useProfileTable(rowAfter, (current, attempt) => {
      // 計算と違う値を、毎回別の値で書く (条件に合わせない)
      current.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE + attempt;
    });

    const outcome = await refreshProfileCompleteness(db.client as never, USER_ID);

    expect(outcome.status).toBe('error');
    expect(outcome.status === 'error' && outcome.error).toBeInstanceOf(ProfileCompletenessWriteExhaustedError);
    expect(completenessWriteQueries(db.queries)).toHaveLength(PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS);
    expect(profileCompletenessOfRow(rowAfter)).toBeLessThan(OTHER_WRITER_COMPLETENESS_BASE);
    expect(row.profile_completeness).toBe(OTHER_WRITER_COMPLETENESS_BASE + PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS);
  });

  it('書き込みのエラーは error で返す (例外は投げない)', async () => {
    const db = createRecordingSupabase((query) =>
      firstMethodOf(query) === 'update' ? { error: DB_FAILURE } : { data: { ...BASE_ROW, height: HEIGHT_CM } },
    );

    const outcome = await refreshProfileCompleteness(db.client as never, USER_ID);

    expect(outcome).toEqual({ status: 'error', error: DB_FAILURE });
  });
});

describe('POST /api/profile/completeness (モバイルのオンボーディングの途中保存のあとに呼ぶ。#2206 G4)', () => {
  it('今の行から完成度を計算し直して書き、計算した値を返す', async () => {
    const rowAfter = { ...BASE_ROW, height: HEIGHT_CM, weight: WEIGHT_KG };
    const { db, row } = useProfileTable(rowAfter);
    routeDb.client = db.client;

    const res = await postProfileCompleteness();

    const expected = profileCompletenessOfRow(rowAfter);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profileCompleteness: expected });
    expect(row.profile_completeness).toBe(expected);
    // 本人の行を読む
    const read = db.queries.find((query) => firstMethodOf(query) === 'select');
    expect(read?.calls).toEqual(expect.arrayContaining([{ method: 'eq', args: ['id', USER_ID] }]));
  });

  it('ログインしていなければ 401 (DB に触れない)', async () => {
    const { db } = useProfileTable(BASE_ROW);
    routeDb.client = db.client;
    routeDb.user = null;

    const res = await postProfileCompleteness();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(db.queries).toEqual([]);
  });

  it('プロフィールの行が無ければ 404', async () => {
    const db = createRecordingSupabase(() => ({ data: null }));
    routeDb.client = db.client;

    const res = await postProfileCompleteness();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: API_NOT_FOUND_MESSAGE });
    expect(completenessWriteQueries(db.queries)).toEqual([]);
  });

  it('読み取りに失敗したら 500 (DB の生の文面は返さない)', async () => {
    const db = createRecordingSupabase(() => ({ error: DB_FAILURE }));
    routeDb.client = db.client;

    const res = await postProfileCompleteness();

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(DB_FAILURE.message);
  });
});
