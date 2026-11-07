// @vitest-environment node
/**
 * #2299 (#2295 の整合の候補 A・C の一部): 実行する (POST /api/ai/consultation/actions/[actionId]/execute) の 400 / 404 に、
 * 断った提案ならカードを閉じる値 (proposedActionHidden: true) を添える。
 *
 * 問題 (直す前):
 *   - 別のタブで断った (rejected の) 提案に「実行する」を押すと、POST の 404 (メッセージ ID で pending の行が無い) は rejected を
 *     failed に写し、カードは「もう一度 AI に頼んでください」になった。開き直すと GET は hidden でカードが消え、見え方が食い違っていた
 *   - 読んでから実行中の印を取る (claim) までの間に別の画面が断ると、claim が 0 行の 400 は runningOrDone に決め打ちし、
 *     「実行中か実行済み」と出た
 *   - 行の id で押して、読んだ時点で rejected のときも 400 は failed (「もう一度 AI に頼んでください」) だった
 *
 * 直したあと:
 *   - 404: そのメッセージの本人の行に rejected があり、executed も approved も無いときは proposedActionHidden: true
 *     (notExecutableReason は付けない)。executed を含むときは今までどおり runningOrDone (#2195 V2 の意図した案内。頼み直しを勧めない)。
 *     それ以外は今までの理由。行が無い・読めないときは何も添えない
 *   - 400 (読んだ時点で pending でない): 行が rejected なら proposedActionHidden: true、それ以外は今までの理由
 *   - 400 (claim が 0 行): そのメッセージの本人の行を読み直し、rejected があり executed も approved も無いときは
 *     proposedActionHidden: true、それ以外 (approved・executed・failed・行が無い・読めない) は今までどおり runningOrDone
 *   - 応答の status (404 / 400) と error の固定の文は変えない
 *
 * 差し替えるのは外との境目 (Supabase のクライアント・ログ・レート制限など) だけ (tests/ai-proposal-reject-not-found-view-2295.test.ts と
 * 同じ小さな表)。RLS は真似しない (コードが本人で絞ることを確かめるため)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '66666666-6666-4666-8666-666666666666';
const ACTION_LOG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ACTION_LOG_ID = '77777777-7777-4777-8777-777777777777';
const AI_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const ACTION_LOGS = 'ai_action_logs';
/** 行の状態を読む問い合わせで、本人で絞る列 */
const OWNER_FILTER_COLUMN = 'ai_consultation_sessions.user_id';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** ai_action_logs の行 (相談と結んだ形) */
  rows: [] as Array<Record<string, unknown>>,
  /** 行の状態の一覧の読み取り (await する select) を失敗させる */
  statusListReadFails: false,
  /** 却下の update を当てる直前に呼ぶ (読んでから書くまでの間に、別の画面・自動実行が行を進めたことを表す) */
  beforeUpdate: null as null | (() => void),
  /** 却下の update が 0 行だったあと (応答を作る前) に呼ぶ */
  afterUpdate: null as null | (() => void),
  /** 行の状態の一覧の読み取りの条件 */
  statusListReads: [] as Array<Array<[string, unknown]>>,
}));

function valueAt(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Row)[key] : undefined), row);
}

function makeQuery(table: string): unknown {
  let op: 'select' | 'update' = 'select';
  let payload: Row = {};
  const filters: Array<[string, unknown]> = [];
  const matching = () =>
    (table === ACTION_LOGS ? h.rows : []).filter((row) => filters.every(([column, value]) => valueAt(row, column) === value));
  const single = () => {
    if (op === 'select') return { data: matching()[0] ?? null, error: null };
    h.beforeUpdate?.();
    const targets = matching();
    for (const row of targets) Object.assign(row, payload);
    if (targets.length === 0) h.afterUpdate?.();
    return { data: targets[0] ? { id: targets[0].id } : null, error: null };
  };
  const awaited = () => {
    h.statusListReads.push([...filters]);
    if (h.statusListReadFails) return { data: null, error: { code: '08006', message: 'connection reset by peer' } };
    return { data: matching().map((row) => ({ ...row })), error: null };
  };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(awaited()).then(resolve, reject);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(single());
        if (prop === 'update') {
          return (next: Row) => {
            op = 'update';
            payload = next;
            return builder;
          };
        }
        if (prop === 'eq') {
          return (column: string, value: unknown) => {
            filters.push([column, value]);
            return builder;
          };
        }
        return () => builder;
      },
    },
  );
  return builder;
}

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER, email: 'user@example.test' } }, error: null }) },
    from: (table: string) => makeQuery(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabase()),
  getSupabaseAdmin: vi.fn(() => makeSupabase()),
}));
vi.mock('@/lib/db-logger', async (importOriginal) => {
  const logger: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  logger.withUser = () => logger;
  return {
    ...(await importOriginal<typeof import('@/lib/db-logger')>()),
    createLogger: () => logger,
    generateRequestId: () => 'req_test',
  };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/ai/ai-chat-gate', () => ({ aiChatDisabledResponse: vi.fn(async () => null) }));
vi.mock('@/lib/ai/consent-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consent-guard')>()),
  requireAiConsent: vi.fn(async () => null),
}));
vi.mock('@/lib/env-required', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env-required')>()),
  getSupabaseServiceConfig: () => ({ url: 'https://supabase.example.test', serviceRoleKey: 'service-role-key-test' }),
}));
vi.mock('@/lib/ai/consultation-action-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consultation-action-executor')>()),
  runConsultationAction: vi.fn(),
}));

const executeRoute = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');
const { AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE } = await import('@/lib/ai/ai-api-messages');
const { runConsultationAction } = await import('@/lib/ai/consultation-action-executor');
const lifecycle = await import('@/lib/ai/consultation-action-lifecycle');

beforeEach(() => {
  h.rows = [];
  h.statusListReadFails = false;
  h.beforeUpdate = null;
  h.afterUpdate = null;
  h.statusListReads = [];
  vi.mocked(runConsultationAction).mockReset();
});

function logRow(status: string, owner: string = USER, id: string = ACTION_LOG_ID): Row {
  return {
    id,
    session_id: owner === USER ? SESSION_ID : OTHER_SESSION_ID,
    message_id: AI_MESSAGE_ID,
    action_type: 'add_pantry_item',
    action_params: { name: '卵' },
    status,
    ai_consultation_sessions: { user_id: owner },
  };
}

function request(method: 'POST' | 'DELETE', actionId: string = AI_MESSAGE_ID) {
  return [
    new Request(`http://localhost/api/ai/consultation/actions/${actionId}/execute`, { method }),
    { params: Promise.resolve({ actionId }) },
  ] as const;
}

/** 手で書いた期待値 (本文) */
const NOT_FOUND_HIDDEN = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, proposedActionHidden: true };
const notFoundWith = (reason: string) => ({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, notExecutableReason: reason });
const NOT_FOUND_BARE = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE };
const PROCESSED_HIDDEN = { error: AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, proposedActionHidden: true };
const processedWith = (reason: string) => ({ error: AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, notExecutableReason: reason });
/** 行の状態の一覧の読み取り (メッセージ ID と本人で絞る) */
const STATUS_LIST_READ = [['message_id', AI_MESSAGE_ID], [OWNER_FILTER_COLUMN, USER]];

async function executeBy(actionId: string = AI_MESSAGE_ID): Promise<{ status: number; body: unknown }> {
  const res = await executeRoute.POST(...request('POST', actionId));
  return { status: res.status, body: await res.json() };
}

describe('純関数: 実行の API の 400 / 404 に添える値 (#2299)', () => {
  it.each([
    [['rejected'], true],
    [['rejected', 'failed'], true],
    [['rejected', 'pending'], true],
    [['rejected', 'executed'], false],
    [['rejected', 'approved'], false],
    [['executed'], false],
    [['approved'], false],
    [['failed'], false],
    [[], false],
  ] as const)('断った提案か %j → %s', (statuses, expected) => {
    expect(lifecycle.proposedActionRejectedOnlyOf(statuses)).toBe(expected);
  });

  it.each([
    [null, {}],
    [[], {}],
    [['rejected'], { proposedActionHidden: true }],
    [['rejected', 'failed'], { proposedActionHidden: true }],
    [['rejected', 'executed'], { notExecutableReason: 'runningOrDone' }],
    [['rejected', 'approved'], { notExecutableReason: 'unconfirmed' }],
    [['executed'], { notExecutableReason: 'runningOrDone' }],
    [['approved'], { notExecutableReason: 'unconfirmed' }],
    [['failed'], { notExecutableReason: 'failed' }],
  ] as const)('404 / 400 (読んだ時点): %j → %j', (statuses, expected) => {
    expect(lifecycle.proposedActionExecuteNotExecutableFieldsOfStatuses(statuses)).toStrictEqual(expected);
  });

  it.each([
    [null, { notExecutableReason: 'runningOrDone' }],
    [[], { notExecutableReason: 'runningOrDone' }],
    [['rejected'], { proposedActionHidden: true }],
    [['rejected', 'executed'], { notExecutableReason: 'runningOrDone' }],
    [['rejected', 'approved'], { notExecutableReason: 'runningOrDone' }],
    [['executed'], { notExecutableReason: 'runningOrDone' }],
    [['approved'], { notExecutableReason: 'runningOrDone' }],
    [['failed'], { notExecutableReason: 'runningOrDone' }],
  ] as const)('claim が 0 行: %j → %j', (statuses, expected) => {
    expect(lifecycle.proposedActionExecuteClaimLostFieldsOfStatuses(statuses)).toStrictEqual(expected);
  });

  it.each([
    [{ proposedActionHidden: true }, true],
    [{ proposedActionHidden: 'true' }, false],
    [{ proposedActionHidden: 1 }, false],
    [{ notExecutableReason: 'failed' }, false],
    [null, false],
    ['proposedActionHidden', false],
  ] as const)('本文がカードを閉じることを示すか %j → %s (許した値 true だけを通す)', (body, expected) => {
    expect(lifecycle.isProposedActionHiddenBody(body)).toBe(expected);
  });
});

describe('POST の 404 (メッセージ ID で pending の行が無い): 断った提案は proposedActionHidden (#2299)', () => {
  it.each([
    ['rejected だけ (別のタブで断った)', [logRow('rejected')], NOT_FOUND_HIDDEN],
    ['rejected と failed', [logRow('rejected'), logRow('failed', USER, OTHER_ACTION_LOG_ID)], NOT_FOUND_HIDDEN],
    ['rejected と executed', [logRow('rejected'), logRow('executed', USER, OTHER_ACTION_LOG_ID)], notFoundWith('runningOrDone')],
    ['rejected と approved', [logRow('rejected'), logRow('approved', USER, OTHER_ACTION_LOG_ID)], notFoundWith('unconfirmed')],
    ['executed', [logRow('executed')], notFoundWith('runningOrDone')],
    ['approved', [logRow('approved')], notFoundWith('unconfirmed')],
    ['failed', [logRow('failed')], notFoundWith('failed')],
    ['行なし', [] as Row[], NOT_FOUND_BARE],
  ])('行が %s: 404 で本文は厳密に期待どおり', async (_label, rows, expected) => {
    h.rows = rows;
    const before = rows.map((row) => row.status);

    const res = await executeBy();

    expect(res).toStrictEqual({ status: 404, body: expected });
    // 行は書き換えない・実行しない
    expect(h.rows.map((row) => row.status)).toEqual(before);
    expect(runConsultationAction).not.toHaveBeenCalled();
    expect(h.statusListReads).toEqual([STATUS_LIST_READ]);
  });

  it('行の状態を読めなかった: 404 で何も添えない', async () => {
    h.rows = [logRow('rejected')];
    h.statusListReadFails = true;

    expect(await executeBy()).toStrictEqual({ status: 404, body: NOT_FOUND_BARE });
  });

  it('他人の rejected の行: その状態は添えず、行が無いときと同じ本文 (有無を漏らさない)', async () => {
    h.rows = [logRow('rejected', OTHER_USER)];

    expect(await executeBy()).toStrictEqual({ status: 404, body: NOT_FOUND_BARE });
    expect(h.statusListReads).toEqual([STATUS_LIST_READ]);
  });

  it('別のタブで断った提案に「実行する」を押す再現: タブ A で断ったあと、タブ B で実行すると 404 で proposedActionHidden (頼み直しを勧めない)', async () => {
    h.rows = [logRow('pending')];

    const rejected = await executeRoute.DELETE(...request('DELETE'));
    expect(rejected.status).toBe(200);
    const executed = await executeBy();

    expect(executed).toStrictEqual({ status: 404, body: NOT_FOUND_HIDDEN });
    expect(executed.body).not.toHaveProperty('notExecutableReason');
    expect(h.rows[0].status).toBe('rejected');
    expect(runConsultationAction).not.toHaveBeenCalled();
  });
});

describe('POST の 400 (行の id で読んだ時点で pending でない): rejected は proposedActionHidden (#2299)', () => {
  it.each([
    ['rejected', [logRow('rejected')], PROCESSED_HIDDEN],
    ['rejected (同じメッセージに executed の行もある。読んだ 1 行の状態で決める)', [logRow('rejected'), logRow('executed', USER, OTHER_ACTION_LOG_ID)], PROCESSED_HIDDEN],
    ['executed', [logRow('executed')], processedWith('runningOrDone')],
    ['approved', [logRow('approved')], processedWith('unconfirmed')],
    ['failed', [logRow('failed')], processedWith('failed')],
  ])('行が %s: 400 で本文は厳密に期待どおり (行の状態の一覧は読まない)', async (_label, rows, expected) => {
    h.rows = rows;

    expect(await executeBy(ACTION_LOG_ID)).toStrictEqual({ status: 400, body: expected });
    expect(h.statusListReads).toEqual([]);
    expect(runConsultationAction).not.toHaveBeenCalled();
    expect(h.rows[0].status).toBe(rows[0].status);
  });
});

describe('POST の 400 (claim が 0 行。読んでから取るまでの間に先を越された): 読み直して、断った提案は proposedActionHidden (#2299)', () => {
  it.each([
    ['別の画面が断った (rejected だけ)', 'rejected', [] as Row[], PROCESSED_HIDDEN],
    ['別の画面が断った (同じメッセージに failed の行もある)', 'rejected', [logRow('failed', USER, OTHER_ACTION_LOG_ID)], PROCESSED_HIDDEN],
    ['rejected と executed', 'rejected', [logRow('executed', USER, OTHER_ACTION_LOG_ID)], processedWith('runningOrDone')],
    ['別の画面・自動実行が実行を終えた (executed)', 'executed', [] as Row[], processedWith('runningOrDone')],
    ['別の画面が実行中の印を取った (approved)', 'approved', [] as Row[], processedWith('runningOrDone')],
    ['実行して失敗した (failed)', 'failed', [] as Row[], processedWith('runningOrDone')],
  ])('%s: 400 で本文は厳密に期待どおり。行は上書きしない', async (_label, raced, others, expected) => {
    h.rows = [logRow('pending'), ...others];
    h.beforeUpdate = () => {
      h.rows[0].status = raced;
    };

    expect(await executeBy()).toStrictEqual({ status: 400, body: expected });
    expect(h.rows[0].status).toBe(raced);
    expect(runConsultationAction).not.toHaveBeenCalled();
    expect(h.statusListReads).toEqual([STATUS_LIST_READ]);
  });

  it('行なし (読み直すと行が消えていた): 今までどおり runningOrDone', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'rejected';
    };
    h.afterUpdate = () => {
      h.rows = [];
    };

    expect(await executeBy()).toStrictEqual({ status: 400, body: processedWith('runningOrDone') });
  });

  it('読み直しで行の状態を読めなかった: 今までどおり runningOrDone', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'rejected';
    };
    h.statusListReadFails = true;

    expect(await executeBy()).toStrictEqual({ status: 400, body: processedWith('runningOrDone') });
  });

  it('行の id で押しても、読み直すのはそのメッセージ (行の message_id) の本人の行', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'rejected';
    };

    expect(await executeBy(ACTION_LOG_ID)).toStrictEqual({ status: 400, body: PROCESSED_HIDDEN });
    expect(h.statusListReads).toEqual([STATUS_LIST_READ]);
  });

  it('他人の rejected の行は読み直しで数えない (本人の行が無い扱いで runningOrDone)', async () => {
    h.rows = [logRow('pending'), logRow('rejected', OTHER_USER, OTHER_ACTION_LOG_ID)];
    h.beforeUpdate = () => {
      h.rows[0].status = 'executed';
    };
    h.afterUpdate = () => {
      h.rows = h.rows.filter((row) => row.id !== ACTION_LOG_ID);
    };

    expect(await executeBy()).toStrictEqual({ status: 400, body: processedWith('runningOrDone') });
  });
});
