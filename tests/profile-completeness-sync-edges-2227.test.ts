// @vitest-environment node
/**
 * #2227 H4 完成度の条件つきの書き込み (src/lib/profile-completeness.ts の syncProfileCompletenessOfRow) の縁
 *
 * 問題 (直す前):
 *   - 最後の試み (PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS 回目) で書けても、continue のあとループが終わり
 *     ProfileCompletenessWriteExhaustedError を返した (POST /api/profile/completeness は 500)
 *   - 一度書けた後に、書き込み・読み直しの失敗・行の消失・上限が起きると、応答の行は渡した行の profile_completeness
 *     (古い値) のままだった (PUT /api/profile は次の読み込みまで古い % を返した)
 *   - 読み直しの失敗・行の消失・上限の枝を固定するテストが無かった
 *
 * 直したあと (このテストが固定する):
 *   - 最後の試みのあとの数え直しは回数に数えない。最後の試みで書けて数え直しも同じなら updated
 *   - 一度書けた後の失敗では、応答の行の完成度は最後に分かった DB の値 (書いた値。そのあと読み直したならその行の値)
 *   - 一度も書けていない失敗では、応答の行は渡した行のまま
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeDb = vi.hoisted(() => ({ client: null as null | Record<string, unknown> }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    ...routeDb.client,
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  }),
}));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ ...logger, withUser: () => logger }), generateRequestId: () => 'request-1' }));

import {
  PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS,
  ProfileCompletenessRowMissingError,
  ProfileCompletenessWriteExhaustedError,
  profileCompletenessOfRow,
  syncProfileCompletenessOfRow,
} from '@/lib/profile-completeness';
import type { DbUserProfile } from '@/types/database';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';
import { POST as postProfileCompleteness } from '@/app/api/profile/completeness/route';

const USER_ID = 'user-1';
const HEIGHT_CM = 170;
const WEIGHT_KG = 62.5;
/** 渡した行に入っていた完成度 (古い値) */
const STALE_COMPLETENESS = 10;
/** 別の書き手が書く完成度の基点 (計算した値と重ならない値) */
const OTHER_WRITER_COMPLETENESS_BASE = 50;
/** DB の失敗 */
const DB_FAILURE = { message: 'db error', code: 'XX000' };

/** 名前・性別・身長の行 (完成度は古い値) */
const PUT_ROW: Partial<DbUserProfile> = {
  id: USER_ID,
  nickname: 'ほり',
  gender: 'female',
  age: null,
  height: HEIGHT_CM,
  weight: null,
  profile_completeness: STALE_COMPLETENESS,
};
/** 渡した行から数えた完成度 (1 回目に書く値) */
const FIRST_WRITE = profileCompletenessOfRow(PUT_ROW);
/** 体重も入った行から数えた完成度 */
const WITH_WEIGHT = profileCompletenessOfRow({ ...PUT_ROW, weight: WEIGHT_KG });

/** 完成度の書き込みが届いたとき (書く前) の振る舞い: 'error' は DB の失敗を返す。それ以外は条件に合えば書く */
type WriteHook = (row: Record<string, unknown>, attempt: number) => 'error' | void;
/** 読み直し (select) の振る舞い: 'error' は DB の失敗、'missing' は行が無い。それ以外は今の行 */
type ReadHook = (reads: number) => 'error' | 'missing' | void;

/** user_profiles の 1 行をまねる (update は eq / is の条件に合うときだけ書き、書けた行を返す。合わなければ 0 行) */
function useProfileTable(initial: Partial<DbUserProfile>, onWrite: WriteHook = () => {}, onRead: ReadHook = () => {}) {
  const row: Record<string, unknown> = { ...initial };
  let writes = 0;
  let reads = 0;
  const db = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    if (firstMethodOf(query) === 'update') {
      const values = query.calls[0].args[0] as Record<string, unknown>;
      writes += 1;
      if (onWrite(row, writes) === 'error') return { error: DB_FAILURE };
      const matches = query.calls
        .filter((call) => call.method === 'eq' || call.method === 'is')
        .every((call) => (row[String(call.args[0])] ?? null) === call.args[1]);
      if (!matches) return { data: null };
      Object.assign(row, values);
      return { data: { ...row } };
    }
    reads += 1;
    const read = onRead(reads);
    if (read === 'error') return { error: DB_FAILURE };
    if (read === 'missing') return { data: null };
    return { data: { ...row } };
  });
  return { db, row, writes: () => writes };
}

/** 1 回目の完成度の書き込みの直前に体重を書く (書いた後の行から数え直すと値が変わり、もう一度書く) */
const weightChangesBeforeFirstWrite: WriteHook = (row, attempt) => {
  if (attempt === 1) row.weight = WEIGHT_KG;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('最後の試みで書けたら updated (#2227 H4)', () => {
  /** 最後の試みの前までは、書くたびに別の書き手が完成度を書き換える (0 行 → 読み直し) */
  const otherWriterUntilLastAttempt: WriteHook = (row, attempt) => {
    if (attempt < PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS) row.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE + attempt;
  };

  it(`${PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS} 回目で書けて数え直しも同じなら updated。応答の行は書いた値`, async () => {
    const table = useProfileTable(PUT_ROW, otherWriterUntilLastAttempt);

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(table.writes()).toBe(PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS);
    expect(table.row.profile_completeness).toBe(FIRST_WRITE);
    expect(synced.outcome).toEqual({ status: 'updated', completeness: FIRST_WRITE });
    expect(synced.row.profile_completeness).toBe(FIRST_WRITE);
  });

  it('POST /api/profile/completeness は 200 で書いた値を返す (500 にしない)', async () => {
    const table = useProfileTable(PUT_ROW, otherWriterUntilLastAttempt);
    routeDb.client = table.db.client;

    const res = await postProfileCompleteness();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profileCompleteness: FIRST_WRITE });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('一度書けた後の失敗では、応答の行の完成度は最後に分かった DB の値 (#2227 H4)', () => {
  it('2 回目の書き込みが失敗したら、行の完成度は 1 回目に書いた値 (渡した行の古い値ではない)', async () => {
    const table = useProfileTable(PUT_ROW, (row, attempt) => {
      weightChangesBeforeFirstWrite(row, attempt);
      return attempt === 2 ? 'error' : undefined;
    });

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome).toEqual({ status: 'error', error: DB_FAILURE });
    expect(table.row.profile_completeness).toBe(FIRST_WRITE);
    expect(synced.row.profile_completeness).toBe(FIRST_WRITE);
    expect(FIRST_WRITE).not.toBe(STALE_COMPLETENESS);
    // 欄は渡した行のまま (完成度だけを DB の値にする)
    expect(synced.row).toEqual({ ...PUT_ROW, profile_completeness: FIRST_WRITE });
  });

  /** 1 回目は書けて (体重が変わり数え直しが違う)、2 回目は別の書き手が完成度を書いて 0 行 → 読み直す */
  const zeroRowsOnSecondWrite: WriteHook = (row, attempt) => {
    weightChangesBeforeFirstWrite(row, attempt);
    if (attempt === 2) row.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE;
  };

  it('書けた後の読み直しが失敗したら error。行の完成度は最後に書いた値', async () => {
    const table = useProfileTable(PUT_ROW, zeroRowsOnSecondWrite, () => 'error');

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome).toEqual({ status: 'error', error: DB_FAILURE });
    expect(synced.row.profile_completeness).toBe(FIRST_WRITE);
  });

  it('書けた後の読み直しで行が無ければ ProfileCompletenessRowMissingError。行の完成度は最後に書いた値', async () => {
    const table = useProfileTable(PUT_ROW, zeroRowsOnSecondWrite, () => 'missing');

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome.status).toBe('error');
    expect(synced.outcome.status === 'error' && synced.outcome.error).toBeInstanceOf(ProfileCompletenessRowMissingError);
    expect(synced.row.profile_completeness).toBe(FIRST_WRITE);
  });

  it('書けた後に上限まで書けなければ ProfileCompletenessWriteExhaustedError。行の完成度は最後に読み直した DB の値', async () => {
    const table = useProfileTable(PUT_ROW, (row, attempt) => {
      weightChangesBeforeFirstWrite(row, attempt);
      if (attempt > 1) row.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE + attempt;
    });

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(table.writes()).toBe(PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS);
    expect(synced.outcome.status).toBe('error');
    expect(synced.outcome.status === 'error' && synced.outcome.error).toBeInstanceOf(ProfileCompletenessWriteExhaustedError);
    const latest = OTHER_WRITER_COMPLETENESS_BASE + PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS;
    expect(table.row.profile_completeness).toBe(latest);
    expect(synced.row.profile_completeness).toBe(latest);
    expect(latest).not.toBe(WITH_WEIGHT);
  });
});

describe('一度も書けていない失敗では、応答の行は渡した行のまま (#2227 H4)', () => {
  it('1 回目の書き込みの失敗', async () => {
    const table = useProfileTable(PUT_ROW, () => 'error');

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome).toEqual({ status: 'error', error: DB_FAILURE });
    expect(synced.row).toBe(PUT_ROW);
  });

  it('1 回目が 0 行で、読み直しが失敗', async () => {
    const table = useProfileTable(
      PUT_ROW,
      (row) => {
        row.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE;
      },
      () => 'error',
    );

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome).toEqual({ status: 'error', error: DB_FAILURE });
    expect(synced.row).toBe(PUT_ROW);
  });

  it('1 回目が 0 行で、読み直すと行が無い', async () => {
    const table = useProfileTable(
      PUT_ROW,
      (row) => {
        row.profile_completeness = OTHER_WRITER_COMPLETENESS_BASE;
      },
      () => 'missing',
    );

    const synced = await syncProfileCompletenessOfRow(table.db.client as never, USER_ID, PUT_ROW);

    expect(synced.outcome.status === 'error' && synced.outcome.error).toBeInstanceOf(ProfileCompletenessRowMissingError);
    expect(synced.row).toBe(PUT_ROW);
  });
});
