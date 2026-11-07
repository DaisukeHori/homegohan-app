// @vitest-environment node
/**
 * #2295 AI 相談の提案の行の書き戻し (writeBackAiActionLog。src/lib/ai/consultation-action-log-writes.ts) を条件つきにする
 *
 * 問題 (修正前): 書き戻しは .eq('id') だけで最大 2 回書いた。1 回目 (例: やり直せる失敗で pending に戻す) が DB には書けたのに
 * 応答が失われて error になると、その間に別の画面の「断る」が pending → rejected にした行を、2 回目が pending で上書きしえた。
 *
 * 直したあと:
 *   - 毎回の update に .eq('status', 'approved') (実行中の印) を足し、.select('id').maybeSingle() で書けた行を受け取る
 *     (#2299 の B で、印を付けた実行の token の条件 .eq('claim_token', ctx.claimToken) も足した。ABA の順は
 *     tests/ai-action-log-write-back-claim-token-2299.test.ts)
 *   - 書けた行が無い (0 行) ときは、書き直さずに { error: null } を返す (上書きしない)。1 回目の試みで 0 行なら warn を残す
 *   - 2 回とも error なら、今までどおり error を返してログ (error) に残す
 *
 * DB の口 (from) は手で作った偽物にする (呼ばれた条件と、試みごとの結果を決められるように)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/db-logger', async (importOriginal) => {
  const logger: Record<string, unknown> = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => h.logWarn(...args),
    error: (...args: unknown[]) => h.logError(...args),
  };
  logger.withUser = () => logger;
  return {
    ...(await importOriginal<typeof import('@/lib/db-logger')>()),
    createLogger: () => logger,
    generateRequestId: () => 'req_test',
  };
});

const {
  AI_ACTION_LOG_WRITE_BACK_ATTEMPTS,
  AI_ACTION_LOG_WRITE_BACK_NOT_RUNNING_LOG,
  writeBackAiActionLog,
} = await import('@/lib/ai/consultation-action-log-writes');

const ROUTE = 'POST /api/ai/consultation/actions/[actionId]/execute';
const ACTION_LOG_ID = '33333333-3333-4333-8333-333333333333';
/** この実行が実行中の印を付けたときに書いた token (#2299 の B) */
const CLAIM_TOKEN = '66666666-6666-4666-8666-666666666666';
const CTX = {
  userId: '11111111-1111-4111-8111-111111111111',
  actionLogId: ACTION_LOG_ID,
  actionType: 'add_pantry_item',
  claimToken: CLAIM_TOKEN,
};
const PAYLOAD = { status: 'pending', executed_at: null };
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const WRITE_BACK_FAILED_LOG = 'AI 相談の提案の行を実行のあとに書き戻せませんでした (実行中の印のまま残ります)';
const NOT_RUNNING_LOG = 'AI 相談の提案の行を書き戻そうとしたら、行がもう実行中の印ではありませんでした (書き戻しませんでした)';
const DB_ERROR = { message: 'connection reset', code: 'XX000' };

/** 1 回の試みの結果: 書けた行 (row) / 条件に合う行が無い (none) / DB の失敗 (error) */
type Attempt = 'row' | 'none' | 'error';

interface RecordedUpdate {
  table: string;
  payload: unknown;
  filters: Array<[string, unknown]>;
  selected: string | null;
  terminal: string | null;
}

/** 試みごとの結果を順に返す偽の DB の口。呼ばれた update の表・中身・条件・終わり方を残す */
function fakeDb(attempts: Attempt[]) {
  const updates: RecordedUpdate[] = [];
  const resultOf = (attempt: Attempt | undefined) => {
    if (attempt === 'error') return { data: null, error: DB_ERROR };
    if (attempt === 'none') return { data: null, error: null };
    return { data: { id: ACTION_LOG_ID }, error: null };
  };
  const from = (table: string) => ({
    update: (payload: unknown) => {
      const record: RecordedUpdate = { table, payload, filters: [], selected: null, terminal: null };
      updates.push(record);
      const result = () => resultOf(attempts[updates.indexOf(record)]);
      const builder = {
        eq: (column: string, value: unknown) => {
          record.filters.push([column, value]);
          return builder;
        },
        select: (columns: string) => {
          record.selected = columns;
          return builder;
        },
        maybeSingle: async () => {
          record.terminal = 'maybeSingle';
          return result();
        },
        // 条件つきの 1 文の終わり (maybeSingle) を通らずに await した (修正前の形): 行は返らない
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          record.terminal = 'await';
          const r = result();
          return Promise.resolve({ data: null, error: r.error }).then(resolve, reject);
        },
      };
      return builder;
    },
  });
  return { db: { from } as unknown as Parameters<typeof writeBackAiActionLog>[0], updates };
}

beforeEach(() => {
  h.logError.mockReset();
  h.logWarn.mockReset();
});

describe('#2295 書き戻しは行が実行中の印 (approved) のときだけ書く', () => {
  it('文は手で書いた期待値と同じ・試す回数は 2 回', () => {
    expect(AI_ACTION_LOG_WRITE_BACK_NOT_RUNNING_LOG).toBe(NOT_RUNNING_LOG);
    expect(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS).toBe(2);
  });

  it('1 回目で書けた: update は [id, status=approved, claim_token=<token>] の条件つきで 1 回だけ出て、書けた行を受け取る。ログは残さない', async () => {
    const { db, updates } = fakeDb(['row']);

    const result = await writeBackAiActionLog(db, ROUTE, CTX, PAYLOAD);

    expect(result).toEqual({ error: null });
    expect(updates).toEqual([
      {
        table: 'ai_action_logs',
        payload: PAYLOAD,
        filters: [
          ['id', ACTION_LOG_ID],
          ['status', 'approved'],
          ['claim_token', CLAIM_TOKEN],
        ],
        selected: 'id',
        terminal: 'maybeSingle',
      },
    ]);
    expect(h.logWarn).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('1 回目が error・2 回目の条件つきの更新が 0 行 (1 回目が実は書けていた・ほかの操作が先に進めた): 上書きせず { error: null }。ログは残さない', async () => {
    const { db, updates } = fakeDb(['error', 'none']);

    const result = await writeBackAiActionLog(db, ROUTE, CTX, PAYLOAD);

    expect(result).toEqual({ error: null });
    expect(updates).toHaveLength(2);
    // 2 回目も実行中の印の条件つき (無条件で書くと、その間に rejected にした行を pending で上書きしうる)
    expect(updates[1].filters).toEqual([
      ['id', ACTION_LOG_ID],
      ['status', 'approved'],
      ['claim_token', CLAIM_TOKEN],
    ]);
    expect(updates[1].terminal).toBe('maybeSingle');
    expect(h.logWarn).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('1 回目が error・2 回目で書けた: { error: null }。ログは残さない', async () => {
    const { db, updates } = fakeDb(['error', 'row']);

    expect(await writeBackAiActionLog(db, ROUTE, CTX, PAYLOAD)).toEqual({ error: null });
    expect(updates).toHaveLength(2);
    expect(h.logWarn).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('2 回とも error: 今までどおり error を返し、ログ (error) に残す', async () => {
    const { db, updates } = fakeDb(['error', 'error']);

    const result = await writeBackAiActionLog(db, ROUTE, CTX, PAYLOAD);

    expect(result).toEqual({ error: DB_ERROR });
    expect(updates).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError).toHaveBeenCalledWith(
      WRITE_BACK_FAILED_LOG,
      expect.anything(),
      expect.objectContaining({ action_id: ACTION_LOG_ID, action_type: 'add_pantry_item', status: 'pending', attempts: 2 }),
    );
    // token の値はログに出さない (#2299 の B)
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain(CLAIM_TOKEN);
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('1 回目が 0 行 (行がもう実行中の印でない・別の実行が印を付け直した。想定外): 書き直さずに { error: null }、warn を残す (token の値は出さない)', async () => {
    const { db, updates } = fakeDb(['none']);

    const result = await writeBackAiActionLog(db, ROUTE, CTX, PAYLOAD);

    expect(result).toEqual({ error: null });
    expect(updates).toHaveLength(1);
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    expect(h.logWarn).toHaveBeenCalledWith(NOT_RUNNING_LOG, {
      action_id: ACTION_LOG_ID,
      action_type: 'add_pantry_item',
      status: 'pending',
      reason: 'not_running_or_claimed_by_another',
    });
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(CLAIM_TOKEN);
    expect(h.logError).not.toHaveBeenCalled();
  });
});
