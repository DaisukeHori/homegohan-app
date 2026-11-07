// @vitest-environment node
/**
 * #2299 の B: AI 相談の提案の行の書き戻し (writeBackAiActionLog。src/lib/ai/consultation-action-log-writes.ts) を、
 * 実行中の印を付けた実行の token (ai_action_logs.claim_token) で絞る。
 *
 * 問題 (修正前): 書き戻しの条件は status = approved だけで、どの実行が付けた印かを見分けなかった。次の順で起きると、
 * 実行済みの提案の行が pending に残った (開き直すと「実行する」が出て、二重に実行しうる)。
 *   1. A の書き戻しの 1 回目 (やり直せる失敗で pending に戻す) が DB には書けたのに、応答が失われる (error)
 *   2. その間に B が pending → approved を取る (B の token を書く)
 *   3. A の 2 回目が、B の approved を pending で上書きする
 *   4. B の書き戻しは 0 行になる
 *
 * 直したあと: 毎回の update に .eq('claim_token', ctx.claimToken) を足す。3 の A の 2 回目は token が一致しないので 0 行で、
 * { error: null } を返す (上書きしない)。B の書き戻しは B の token で当たる。
 *
 * DB の口は、1 行の状態 (status・claim_token) を持ち、update の条件 (eq) に合うときだけ書く偽物にする
 * (PostgREST の条件つきの update と同じく、条件に合わなければ 0 行)。実 DB での同じ順は
 * tests/integration/rls/ai-action-logs-claim-token-2299.test.ts。
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

const { newAiActionLogClaimToken, writeBackAiActionLog } = await import('@/lib/ai/consultation-action-log-writes');

const ROUTE = 'POST /api/ai/consultation/actions/[actionId]/execute';
const ACTION_LOG_ID = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ctxOf = (claimToken: string) => ({ userId: USER, actionLogId: ACTION_LOG_ID, actionType: 'add_pantry_item', claimToken });
const DB_ERROR = { message: 'connection reset', code: 'XX000' };
/** UUID の形 (crypto.randomUUID() の値) */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

/**
 * 1 行を持つ偽の DB の口。update は eq の条件がすべて行に合うときだけ書き、書けた行 ({ id }) か null を返す。
 * beforeAttempt は update の試みの前に呼ぶ (n 回目の試み)。lostResponseOn の試みは、書いたうえで応答を失う (error を返す)
 */
function rowDb(row: Row, opts: { lostResponseOn?: number[]; beforeAttempt?: (n: number) => void } = {}) {
  const updates: Array<{ payload: Row; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    expect(table).toBe('ai_action_logs');
    return {
      update: (payload: Row) => {
        const record = { payload, filters: [] as Array<[string, unknown]> };
        updates.push(record);
        const attempt = updates.length;
        const builder = {
          eq: (column: string, value: unknown) => {
            record.filters.push([column, value]);
            return builder;
          },
          select: () => builder,
          maybeSingle: async () => {
            opts.beforeAttempt?.(attempt);
            const matches = record.filters.every(([column, value]) => row[column] === value);
            if (matches) Object.assign(row, payload);
            if (opts.lostResponseOn?.includes(attempt)) return { data: null, error: DB_ERROR };
            return { data: matches ? { id: row.id } : null, error: null };
          },
        };
        return builder;
      },
    };
  };
  return { db: { from } as unknown as Parameters<typeof writeBackAiActionLog>[0], updates };
}

beforeEach(() => {
  h.logError.mockReset();
  h.logWarn.mockReset();
});

describe('#2299 の B 書き戻しは、印を付けた実行の token の行だけに書く', () => {
  it('update は [id, status=approved, claim_token=<token>] の条件で出る', async () => {
    const row: Row = { id: ACTION_LOG_ID, status: 'approved', claim_token: TOKEN_A };
    const { db, updates } = rowDb(row);

    expect(await writeBackAiActionLog(db, ROUTE, ctxOf(TOKEN_A), { status: 'executed' })).toEqual({ error: null });

    expect(updates.map((u) => u.filters)).toEqual([
      [
        ['id', ACTION_LOG_ID],
        ['status', 'approved'],
        ['claim_token', TOKEN_A],
      ],
    ]);
    expect(row.status).toBe('executed');
  });

  it('書き戻しは claim_token を書き換えない (payload のまま。次の claim が新しい token で上書きする)', async () => {
    const row: Row = { id: ACTION_LOG_ID, status: 'approved', claim_token: TOKEN_A };
    const { db, updates } = rowDb(row);

    await writeBackAiActionLog(db, ROUTE, ctxOf(TOKEN_A), { status: 'pending', executed_at: null });

    expect(updates[0].payload).toEqual({ status: 'pending', executed_at: null });
    expect(row.claim_token).toBe(TOKEN_A);
  });

  it('ABA: A の 1 回目が書けたのに応答を失い、その間に B が印を取ると、A の 2 回目は token が一致せず 0 行で { error: null }。B の行は上書きされず、B の書き戻しが当たる', async () => {
    const row: Row = { id: ACTION_LOG_ID, status: 'approved', claim_token: TOKEN_A };
    const { db, updates } = rowDb(row, {
      lostResponseOn: [1],
      beforeAttempt: (n) => {
        // A の 2 回目の前: B が pending → approved を取り、B の token を書く (execute の POST の claim と同じ)
        if (n === 2) {
          expect(row.status).toBe('pending');
          Object.assign(row, { status: 'approved', claim_token: TOKEN_B });
        }
      },
    });

    // A: やり直せる失敗で pending に戻す書き戻し
    const resultA = await writeBackAiActionLog(db, ROUTE, ctxOf(TOKEN_A), { status: 'pending', executed_at: null });

    expect(resultA).toEqual({ error: null });
    expect(updates).toHaveLength(2);
    expect(updates[1].filters).toEqual([
      ['id', ACTION_LOG_ID],
      ['status', 'approved'],
      ['claim_token', TOKEN_A],
    ]);
    // B の印は残る (修正前は A の 2 回目が pending で上書きしていた)
    expect(row).toMatchObject({ status: 'approved', claim_token: TOKEN_B });
    // 1 回目の試みは書けた (応答だけ失った) ので warn も error のログも残さない
    expect(h.logWarn).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();

    // B: 実行が成功して executed に書き戻す。B の token で当たる
    const resultB = await writeBackAiActionLog(db, ROUTE, ctxOf(TOKEN_B), { status: 'executed' });

    expect(resultB).toEqual({ error: null });
    expect(row).toMatchObject({ status: 'executed', claim_token: TOKEN_B });
  });

  it('別の実行の印 (token が違う approved) の行には、1 回目から書かない (0 行・warn の理由つき・token の値は出さない)', async () => {
    const row: Row = { id: ACTION_LOG_ID, status: 'approved', claim_token: TOKEN_B };
    const { db, updates } = rowDb(row);

    expect(await writeBackAiActionLog(db, ROUTE, ctxOf(TOKEN_A), { status: 'pending', executed_at: null })).toEqual({
      error: null,
    });

    expect(updates).toHaveLength(1);
    expect(row).toMatchObject({ status: 'approved', claim_token: TOKEN_B });
    expect(h.logWarn).toHaveBeenCalledTimes(1);
    expect(h.logWarn.mock.calls[0][1]).toMatchObject({ reason: 'not_running_or_claimed_by_another' });
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(TOKEN_A);
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(TOKEN_B);
  });

  it('newAiActionLogClaimToken は呼ぶたびに別の UUID を返す', () => {
    const first = newAiActionLogClaimToken();
    const second = newAiActionLogClaimToken();

    expect(first).toMatch(UUID_SHAPE);
    expect(second).toMatch(UUID_SHAPE);
    expect(first).not.toBe(second);
  });
});
