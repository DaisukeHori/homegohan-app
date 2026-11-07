// @vitest-environment node
/**
 * #2295 (integrity-1107c の是正): 断る API (DELETE /api/ai/consultation/actions/[actionId]/execute) の 404 に、カードの見え方を添える。
 *
 * 問題 (直す前): DELETE の 404 は、行が rejected (別の画面で断った)・executed・failed・approved のまま (書き戻せなかった)・行が無い、
 * のどれでも本文が { error } だけだった。Web の「断る」は 404 をいつも「この提案は実行中か実行済みです。」にしていたので、
 * 2 つのタブで同じ相談を開いてタブ A で断ったあと、タブ B で断ると、実行していないのに「実行中か実行済み」と出ていた。
 *
 * 直したあと: pending の行が見つからない 404 (メッセージ ID の探索で無い) と、条件つきの更新が 0 行の 404 (#2294) で、そのメッセージの
 * 自分の相談の行の状態を読み、相談を開き直したときの GET と同じ見え方 (proposedActionViewOf) を添える:
 *   - hidden (rejected / executed): proposedActionHidden: true
 *   - unconfirmed (approved のまま): notExecutableReason: 'unconfirmed'
 *   - notExecutable (failed・行が無い): notExecutableReason: 'failed'
 *   - executable (間に pending に戻った)・読めなかった: 何も添えない
 * UUID でない・持ち主でない 404 は今のまま何も添えない。行の状態は ai_consultation_sessions.user_id = 本人 で絞って読む
 * (ほかの人の行の状態は添えない)。POST の応答は変えない (#2299 で、POST の 404 も断った提案には proposedActionHidden を添えるように改めた)。
 *
 * 差し替えるのは外との境目 (Supabase のクライアント・ログ・レート制限など) だけ。Supabase は、行を持つ小さな表として振る舞う
 * (eq の条件で絞る・update は条件に合う行だけを書き換える)。RLS は真似しない (コードが本人で絞ることを確かめるため)。
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
const { AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE } = await import('@/lib/ai/ai-api-messages');

beforeEach(() => {
  h.rows = [];
  h.statusListReadFails = false;
  h.beforeUpdate = null;
  h.afterUpdate = null;
  h.statusListReads = [];
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

async function rejectByMessage(actionId: string = AI_MESSAGE_ID): Promise<{ status: number; body: unknown }> {
  const res = await executeRoute.DELETE(...request('DELETE', actionId));
  return { status: res.status, body: await res.json() };
}

/** 手で書いた期待値 (404 の本文) */
const HIDDEN_BODY = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, proposedActionHidden: true };
const UNCONFIRMED_BODY = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, notExecutableReason: 'unconfirmed' };
const FAILED_BODY = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, notExecutableReason: 'failed' };
const BARE_BODY = { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE };

describe('DELETE の 404 (pending の行が無い): そのメッセージの行の状態から、カードの見え方を添える (#2295)', () => {
  it.each([
    ['rejected (別の画面で断った)', 'rejected', HIDDEN_BODY],
    ['executed (実行済み)', 'executed', HIDDEN_BODY],
    ['approved のまま (書き戻せなかった)', 'approved', UNCONFIRMED_BODY],
    ['failed', 'failed', FAILED_BODY],
  ])('行が %s: 404 で、本文は GET と同じ見え方', async (_label, status, expected) => {
    h.rows = [logRow(status)];

    const res = await rejectByMessage();

    expect(res).toEqual({ status: 404, body: expected });
    // 行は書き換えない (断った・実行済みの行を rejected で上書きしない)
    expect(h.rows[0].status).toBe(status);
    // 行の状態は、メッセージ ID と本人で絞って読む
    expect(h.statusListReads).toEqual([[['message_id', AI_MESSAGE_ID], [OWNER_FILTER_COLUMN, USER]]]);
  });

  it('行が無い: 404 で notExecutableReason: failed (GET の「記録が無い」と同じ)', async () => {
    expect(await rejectByMessage()).toEqual({ status: 404, body: FAILED_BODY });
  });

  it('行の状態を読めなかった: 404 で何も添えない (DB の生の文面も出さない)', async () => {
    h.rows = [logRow('rejected')];
    h.statusListReadFails = true;

    expect(await rejectByMessage()).toEqual({ status: 404, body: BARE_BODY });
  });

  it('1 つのメッセージに複数の行: GET と同じ順 (断った・実行済みがあれば hidden > 実行中の印 > それ以外)', async () => {
    h.rows = [logRow('failed', USER, ACTION_LOG_ID), logRow('approved', USER, OTHER_ACTION_LOG_ID)];
    expect(await rejectByMessage()).toEqual({ status: 404, body: UNCONFIRMED_BODY });

    h.rows = [logRow('approved', USER, ACTION_LOG_ID), logRow('executed', USER, OTHER_ACTION_LOG_ID)];
    expect(await rejectByMessage()).toEqual({ status: 404, body: HIDDEN_BODY });
  });

  it('他人の行 (ほかの人の相談の rejected の行): その状態は添えず、行が無いときと同じ本文 (有無を漏らさない)', async () => {
    h.rows = [logRow('rejected', OTHER_USER)];

    const res = await rejectByMessage();

    expect(res).toEqual({ status: 404, body: FAILED_BODY });
    expect(res.body).not.toHaveProperty('proposedActionHidden');
    expect(h.statusListReads).toEqual([[['message_id', AI_MESSAGE_ID], [OWNER_FILTER_COLUMN, USER]]]);
    expect(h.rows[0].status).toBe('rejected');
  });

  it('他人の pending の行 (持ち主でない 404): 今のまま何も添えない・書かない', async () => {
    h.rows = [logRow('pending', OTHER_USER)];

    expect(await rejectByMessage()).toEqual({ status: 404, body: BARE_BODY });
    expect(h.rows[0].status).toBe('pending');
    expect(h.statusListReads).toEqual([]);
  });

  it('UUID でない id: 今のまま何も添えない (行の状態も読まない)', async () => {
    h.rows = [logRow('rejected')];

    expect(await rejectByMessage('not-a-uuid')).toEqual({ status: 404, body: BARE_BODY });
    expect(h.statusListReads).toEqual([]);
  });

  it('pending の行: 断れる (200)。行の状態の一覧は読まない', async () => {
    h.rows = [logRow('pending')];

    const res = await executeRoute.DELETE(...request('DELETE'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.rows[0].status).toBe('rejected');
    expect(h.statusListReads).toEqual([]);
  });

  it('2 つのタブの再現: タブ A で断ったあと、タブ B で断ると 404 で proposedActionHidden (「実行中か実行済み」の理由を添えない)', async () => {
    h.rows = [logRow('pending')];

    const first = await executeRoute.DELETE(...request('DELETE'));
    expect(first.status).toBe(200);
    const second = await rejectByMessage();

    expect(second).toEqual({ status: 404, body: HIDDEN_BODY });
    expect(second.body).not.toHaveProperty('notExecutableReason');
  });
});

describe('DELETE の 404 (条件つきの更新が 0 行。読んだあとに先に進んだ。#2294): そのメッセージの行の状態から、カードの見え方を添える (#2295)', () => {
  it.each([
    ['別の画面で断った (rejected)', 'rejected', HIDDEN_BODY],
    ['自動実行が実行を終えた (executed)', 'executed', HIDDEN_BODY],
    ['別の画面が実行中の印を取った (approved)', 'approved', UNCONFIRMED_BODY],
    ['実行して失敗した (failed)', 'failed', FAILED_BODY],
  ])('%s: 404 で、本文は GET と同じ見え方。行は上書きしない', async (_label, raced, expected) => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = raced;
    };

    expect(await rejectByMessage()).toEqual({ status: 404, body: expected });
    expect(h.rows[0].status).toBe(raced);
    expect(h.statusListReads).toEqual([[['message_id', AI_MESSAGE_ID], [OWNER_FILTER_COLUMN, USER]]]);
  });

  it('行の id で断っても、そのメッセージ (行の message_id) の状態を読む', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'rejected';
    };

    expect(await rejectByMessage(ACTION_LOG_ID)).toEqual({ status: 404, body: HIDDEN_BODY });
    expect(h.statusListReads).toEqual([[['message_id', AI_MESSAGE_ID], [OWNER_FILTER_COLUMN, USER]]]);
  });

  it('間に pending に戻った (更新の時点では pending でなく、読み直すと pending): 404 で何も添えない', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'approved';
    };
    h.afterUpdate = () => {
      h.rows[0].status = 'pending';
    };

    expect(await rejectByMessage()).toEqual({ status: 404, body: BARE_BODY });
    expect(h.rows[0].status).toBe('pending');
  });

  it('行の状態を読めなかった: 404 で何も添えない', async () => {
    h.rows = [logRow('pending')];
    h.beforeUpdate = () => {
      h.rows[0].status = 'rejected';
    };
    h.statusListReadFails = true;

    expect(await rejectByMessage()).toEqual({ status: 404, body: BARE_BODY });
  });
});

describe('POST の 404 (行の状態を読む部分を DELETE と共にする。rejected は #2299 で proposedActionHidden に改めた)', () => {
  it.each([
    ['行が無い', [] as Row[], BARE_BODY],
    // #2299: 別のタブで断った提案は、開き直したときの GET と同じくカードを閉じる (以前は failed に写していた)
    ['rejected', [logRow('rejected')], HIDDEN_BODY],
    ['executed', [logRow('executed')], { error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, notExecutableReason: 'runningOrDone' }],
    ['approved のまま', [logRow('approved')], UNCONFIRMED_BODY],
    ['failed', [logRow('failed')], FAILED_BODY],
  ])('メッセージ ID の行が %s: 今までと同じ本文', async (_label, rows, expected) => {
    h.rows = rows;

    const res = await executeRoute.POST(...request('POST'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(expected);
  });

  it('行の状態を読めなかった: 今までと同じく理由を添えない', async () => {
    h.rows = [logRow('executed')];
    h.statusListReadFails = true;

    const res = await executeRoute.POST(...request('POST'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(BARE_BODY);
  });
});
