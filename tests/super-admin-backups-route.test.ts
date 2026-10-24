/**
 * #1129 / #1191 GET /api/super-admin/backups と POST /api/super-admin/backups/dr-tests の単体テスト
 * 設計: docs/design/cross/17-backup-automation.md §7.1・§7.2・§11・§15 の super-admin-backups-route の行 (段 B)
 *
 * requireRole (段 B の AAL2 のゲートを含む) と recordAdminAudit は本物を通す。Supabase の client (本人・service_role) は偽物。
 * admin_audit_logs の偽物は eq / is / in / order / limit / maybeSingle を行の表に当てて評価し、呼び出しを記録する
 * (route の絞り込みを書き忘れると、その行が応答に混ざる形で落ちる)。
 * 2 つの route はファイルの一番外側で読む (テスト・フックの中で import しない。§18 の heavy-unit-test-timeout の行)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_AUDIT_ACTION_TYPES,
  BACKUP_AUDIT_SELECT,
  BACKUP_AUDIT_TARGET_TYPE,
  BACKUP_STATUS_LIST_LIMIT,
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_ACTION_TYPES,
  DR_TEST_AUDIT_TARGET_TYPE,
  DR_TEST_LIST_LIMIT,
  backupAuditAction,
  type BackupAuditRow,
} from '@/lib/backups/core';
import { invalidJsonBodyBody } from '@/lib/super-admin/validation-errors';

type Row = Record<string, unknown>;

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface PgError {
  message: string;
  code?: string;
}

const mocks = vi.hoisted(() => {
  const state = {
    user: null as null | { id: string; email: string },
    profile: null as null | { roles: string[]; organization_id: null; frozen_at: null; unban_at: null },
    /** admin_audit_logs の行 (偽物が絞り込み・並べ替え・上限を当てる) */
    auditRows: [] as Array<Record<string, unknown>>,
    /** super_admin の一覧 (service_role の user_profiles の読み取り) の結果 */
    superAdminIds: [] as string[],
    superAdminError: null as null | { message: string; code?: string },
    /** admin_audit_logs の読み取りを失敗させる条件 (呼び出しの記録を見て決める) */
    failAuditRead: null as null | ((calls: Array<{ method: string; args: unknown[] }>) => boolean),
    /** maybeSingle の戻りを差し替える (action_type → 行)。偽物の絞り込みを通さずに返す */
    forceLatest: {} as Record<string, Record<string, unknown>>,
    insertError: null as null | { message: string; code?: string },
  };
  const auditQueries: Array<Array<{ method: string; args: unknown[] }>> = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const adminCalls: Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }> = [];
  const order: string[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    state,
    auditQueries,
    auditInserts,
    adminCalls,
    order,
    logger,
    createClient: vi.fn(),
    getSupabaseAdmin: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

import { GET } from '../src/app/api/super-admin/backups/route';
import { POST } from '../src/app/api/super-admin/backups/dr-tests/route';
import { aal2AuthMock } from './helpers/mfa-claims';

const SUPER_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SUPER_ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const NOW_MS = Date.now();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RAW_DB_TEXT = 'relation "admin_audit_logs" secret_detail';

// ─────────────────────────────────────────────────────────────────────────────
// 偽物の Supabase
// ─────────────────────────────────────────────────────────────────────────────

/** admin_audit_logs の読み取りの偽物 (このルートが使う部分だけを評価する) */
function auditQuery() {
  const calls: RecordedCall[] = [];
  mocks.auditQueries.push(calls);
  const evaluate = (): Row[] => {
    let rows: Row[] = mocks.state.auditRows.map((r) => ({ ...r }));
    let limit: number | null = null;
    for (const { method, args } of calls) {
      if (method === 'eq') rows = rows.filter((r) => r[String(args[0])] === args[1]);
      if (method === 'is') rows = rows.filter((r) => r[String(args[0])] === args[1]);
      if (method === 'in') {
        const values = args[1] as unknown[];
        rows = rows.filter((r) => values.includes(r[String(args[0])]));
      }
      if (method === 'limit') limit = Number(args[0]);
    }
    rows.sort((a, b) => {
      const byTime = String(b.created_at).localeCompare(String(a.created_at));
      return byTime !== 0 ? byTime : String(b.id).localeCompare(String(a.id));
    });
    return limit === null ? rows : rows.slice(0, limit);
  };
  const failure = (): PgError | null => (mocks.state.failAuditRead?.(calls) ? { message: RAW_DB_TEXT, code: '42P01' } : null);
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.maybeSingle = async () => {
    calls.push({ method: 'maybeSingle', args: [] });
    const error = failure();
    if (error) return { data: null, error };
    const action = calls.find((c) => c.method === 'eq' && c.args[0] === 'action_type')?.args[1];
    const forced = typeof action === 'string' ? mocks.state.forceLatest[action] : undefined;
    if (forced) return { data: forced, error: null };
    return { data: evaluate()[0] ?? null, error: null };
  };
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const error = failure();
    return Promise.resolve(error ? { data: null, error } : { data: evaluate(), error: null }).then(resolve, reject);
  };
  return builder;
}

function userClient() {
  const getUser = async () =>
    mocks.state.user
      ? { data: { user: mocks.state.user }, error: null }
      : { data: { user: null }, error: { message: 'Auth session missing!' } };
  return {
    auth: { getUser, ...aal2AuthMock(getUser) },
    from: (table: string) => {
      if (table === 'user_profiles') {
        // requireRole の本人のプロフィール
        const builder = {
          select: () => builder,
          eq: () => builder,
          single: async () =>
            mocks.state.profile ? { data: mocks.state.profile, error: null } : { data: null, error: { message: 'no rows' } },
        };
        return builder;
      }
      if (table === 'admin_audit_logs') {
        const query = auditQuery();
        return {
          ...query,
          insert: async (values: Row) => {
            mocks.order.push('insert:admin_audit_logs');
            mocks.auditInserts.push(values);
            return { error: mocks.state.insertError };
          },
        };
      }
      throw new Error(`本人の client が ${table} に触れた`);
    },
  };
}

function adminClient() {
  return {
    from: (table: string) => {
      const calls: RecordedCall[] = [];
      mocks.adminCalls.push({ table, calls });
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'contains', 'eq', 'in']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(
          mocks.state.superAdminError
            ? { data: null, error: mocks.state.superAdminError }
            : { data: mocks.state.superAdminIds.map((id) => ({ id })), error: null },
        ).then(resolve, reject);
      return builder;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 行
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function auditRow(overrides: Partial<BackupAuditRow> & { created_at: string }): BackupAuditRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    action_type: backupAuditAction('daily', 'completed'),
    target_type: BACKUP_AUDIT_TARGET_TYPE,
    actor_id: null,
    severity: 'info',
    details: { key: 'daily/2026-10-20/x.tar.zst.age' },
    ...overrides,
  };
}

const at = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();

const backupRow = (tier: 'daily' | 'weekly' | 'annual', msAgo: number, overrides: Partial<BackupAuditRow> = {}) =>
  auditRow({ action_type: backupAuditAction(tier, 'completed'), created_at: at(msAgo), ...overrides });

const drRow = (kind: keyof typeof DR_TEST_AUDIT_ACTIONS, msAgo: number, overrides: Partial<BackupAuditRow> = {}) =>
  auditRow({
    action_type: DR_TEST_AUDIT_ACTIONS[kind],
    target_type: DR_TEST_AUDIT_TARGET_TYPE,
    actor_id: SUPER_ADMIN_ID,
    created_at: at(msAgo),
    details: { kind, result: 'success' },
    ...overrides,
  });

function loginAs(id: string, roles: string[]) {
  mocks.state.user = { id, email: `${id}@example.com` };
  mocks.state.profile = { roles, organization_id: null, frozen_at: null, unban_at: null };
}

const callArgs = (calls: RecordedCall[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

/** 読み取りの記録のうち、action_type の eq が value のもの */
const queryForAction = (action: string) =>
  mocks.auditQueries.find((calls) => calls.some((c) => c.method === 'eq' && c.args[0] === 'action_type' && c.args[1] === action));

/** 読み取りの記録のうち、action_type の in が values と同じもの */
const queryForActionList = (values: readonly string[]) =>
  mocks.auditQueries.find((calls) =>
    calls.some((c) => c.method === 'in' && c.args[0] === 'action_type' && JSON.stringify(c.args[1]) === JSON.stringify([...values])),
  );

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mocks.auditQueries.length = 0;
  mocks.auditInserts.length = 0;
  mocks.adminCalls.length = 0;
  mocks.order.length = 0;
  mocks.state.auditRows = [];
  mocks.state.superAdminIds = [SUPER_ADMIN_ID, OTHER_SUPER_ADMIN_ID];
  mocks.state.superAdminError = null;
  mocks.state.failAuditRead = null;
  mocks.state.forceLatest = {};
  mocks.state.insertError = null;
  loginAs(SUPER_ADMIN_ID, ['super_admin']);
  mocks.createClient.mockImplementation(async () => {
    mocks.order.push('createClient');
    return userClient();
  });
  mocks.getSupabaseAdmin.mockImplementation(() => {
    mocks.order.push('getSupabaseAdmin');
    return adminClient();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/super-admin/backups', () => {
  it('未ログインは 401・admin は 403。どちらも getSupabaseAdmin を呼ばず、admin_audit_logs に触れない', async () => {
    mocks.state.user = null;
    const unauth = await GET();
    expect(unauth.status).toBe(401);
    expect((await unauth.json()).error.code).toBe('UNAUTHORIZED');

    loginAs(ADMIN_ID, ['admin']);
    const forbidden = await GET();
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe('FORBIDDEN');

    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.auditQueries).toHaveLength(0);
  });

  it('super_admin は 200。requireRole の後に getSupabaseAdmin の client で user_profiles を 1 本だけ読む (admin_audit_logs は読まない)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.adminCalls.map((c) => c.table)).toEqual(['user_profiles']);
    const [{ calls }] = mocks.adminCalls;
    expect(callArgs(calls, 'select')).toEqual([['id']]);
    expect(callArgs(calls, 'contains')).toEqual([['roles', ['super_admin']]]);
    // requireRole (本人の client の作成) が先で、service_role はその後
    expect(mocks.order.indexOf('createClient')).toBeLessThan(mocks.order.indexOf('getSupabaseAdmin'));
  });

  it('admin_audit_logs は本人の client で 8 本: 取得の最新 3・訓練の最新 3・一覧 2 (印の絞り込み・並び・上限・列)', async () => {
    await GET();
    expect(mocks.auditQueries).toHaveLength(8);
    for (const calls of mocks.auditQueries) {
      expect(callArgs(calls, 'select')).toEqual([[BACKUP_AUDIT_SELECT]]);
      expect(callArgs(calls, 'order')).toEqual([
        ['created_at', { ascending: false }],
        ['id', { ascending: false }],
      ]);
    }
    for (const tier of ['daily', 'weekly', 'annual'] as const) {
      const calls = queryForAction(backupAuditAction(tier, 'completed'));
      expect(calls).toBeDefined();
      expect(callArgs(calls ?? [], 'eq')).toEqual([
        ['action_type', backupAuditAction(tier, 'completed')],
        ['target_type', 'database_backup'],
      ]);
      expect(callArgs(calls ?? [], 'is')).toEqual([['actor_id', null]]);
      expect(callArgs(calls ?? [], 'limit')).toEqual([[1]]);
      expect(callArgs(calls ?? [], 'maybeSingle')).toHaveLength(1);
    }
    for (const action of DR_TEST_AUDIT_ACTION_TYPES) {
      const calls = queryForAction(action);
      expect(calls).toBeDefined();
      expect(callArgs(calls ?? [], 'eq')).toEqual([
        ['action_type', action],
        ['target_type', 'dr_test'],
      ]);
      expect(callArgs(calls ?? [], 'in')).toEqual([['actor_id', [SUPER_ADMIN_ID, OTHER_SUPER_ADMIN_ID]]]);
      expect(callArgs(calls ?? [], 'limit')).toEqual([[1]]);
    }
    const backupList = queryForActionList(BACKUP_AUDIT_ACTION_TYPES);
    expect(callArgs(backupList ?? [], 'eq')).toEqual([['target_type', 'database_backup']]);
    expect(callArgs(backupList ?? [], 'is')).toEqual([['actor_id', null]]);
    expect(callArgs(backupList ?? [], 'limit')).toEqual([[BACKUP_STATUS_LIST_LIMIT]]);
    const drList = queryForActionList(DR_TEST_AUDIT_ACTION_TYPES);
    expect(callArgs(drList ?? [], 'eq')).toEqual([['target_type', 'dr_test']]);
    expect(callArgs(drList ?? [], 'in')).toEqual([
      ['action_type', [...DR_TEST_AUDIT_ACTION_TYPES]],
      ['actor_id', [SUPER_ADMIN_ID, OTHER_SUPER_ADMIN_ID]],
    ]);
    expect(callArgs(drList ?? [], 'limit')).toEqual([[DR_TEST_LIST_LIMIT]]);
  });

  it('select の列は BACKUP_AUDIT_SELECT と同じ文字列 (route は文字列リテラルで書く。select-columns-exist が見る)', async () => {
    expect(BACKUP_AUDIT_SELECT).toBe('id, created_at, action_type, target_type, actor_id, severity, details');
    await GET();
    const selects = new Set(mocks.auditQueries.flatMap((calls) => callArgs(calls, 'select').map((args) => args[0])));
    expect([...selects]).toEqual([BACKUP_AUDIT_SELECT]);
  });

  it('一覧の窓に annual の行が無くても、backup.annual.completed の最新 1 行が data.latest.annual に出る (S-18)', async () => {
    const annual = backupRow('annual', 200 * DAY_MS);
    const dailies = Array.from({ length: BACKUP_STATUS_LIST_LIMIT + 5 }, (_, i) => backupRow('daily', (i + 1) * HOUR_MS));
    mocks.state.auditRows = [annual, ...dailies];

    const json = await (await GET()).json();
    expect(json.data.backups).toHaveLength(BACKUP_STATUS_LIST_LIMIT);
    expect(json.data.backups.some((r: Row) => r.id === annual.id)).toBe(false);
    expect(json.data.latest.annual).toEqual(annual);
    expect(json.data.latest.daily).toEqual(dailies[0]);
    expect(json.data.latest.weekly).toBeNull();
    expect(json.data.stale).toBe(false);
  });

  it('dr の一覧に annual_drill が無くても data.latest_dr_tests.annual_drill に出る', async () => {
    const drill = drRow('annual_drill', 400 * DAY_MS);
    const monthlies = Array.from({ length: DR_TEST_LIST_LIMIT + 3 }, (_, i) => drRow('monthly_pitr', (i + 1) * DAY_MS));
    mocks.state.auditRows = [drill, ...monthlies];

    const json = await (await GET()).json();
    expect(json.data.dr_tests).toHaveLength(DR_TEST_LIST_LIMIT);
    expect(json.data.dr_tests.some((r: Row) => r.id === drill.id)).toBe(false);
    expect(json.data.latest_dr_tests.annual_drill).toEqual(drill);
    expect(json.data.latest_dr_tests.monthly_pitr).toEqual(monthlies[0]);
    expect(json.data.latest_dr_tests.quarterly_restore).toBeNull();
  });

  it('運営のロールの人が自分の JWT で書いた偽の行 (actor_id = 本人) は、取得の行にも訓練の行にも出ない (S-23)', async () => {
    const real = backupRow('daily', 40 * HOUR_MS);
    const fakeBackup = backupRow('daily', HOUR_MS, { actor_id: ADMIN_ID });
    const fakeDr = drRow('annual_drill', HOUR_MS, { actor_id: ADMIN_ID });
    const otherTarget = backupRow('daily', 2 * HOUR_MS, { target_type: 'user' });
    mocks.state.auditRows = [real, fakeBackup, fakeDr, otherTarget];

    const json = await (await GET()).json();
    expect(json.data.latest.daily).toEqual(real);
    expect(json.data.stale).toBe(true);
    expect(json.data.backups).toEqual([real]);
    expect(json.data.latest_dr_tests.annual_drill).toBeNull();
    expect(json.data.dr_tests).toEqual([]);
  });

  it('モックが actor_id のある daily の最新の行を返しても data.latest.daily が null で stale が true (core の見直し)', async () => {
    mocks.state.forceLatest[backupAuditAction('daily', 'completed')] = backupRow('daily', HOUR_MS, { actor_id: ADMIN_ID });
    const json = await (await GET()).json();
    expect(json.data.latest.daily).toBeNull();
    expect(json.data.stale).toBe(true);
  });

  it('super_admin の一覧が [] なら訓練の 4 本を呼ばず、latest_dr_tests がすべて null・dr_tests が []', async () => {
    mocks.state.superAdminIds = [];
    mocks.state.auditRows = [drRow('monthly_pitr', HOUR_MS), backupRow('daily', HOUR_MS)];

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(mocks.auditQueries).toHaveLength(4);
    for (const action of DR_TEST_AUDIT_ACTION_TYPES) expect(queryForAction(action)).toBeUndefined();
    expect(queryForActionList(DR_TEST_AUDIT_ACTION_TYPES)).toBeUndefined();
    expect(json.data.latest_dr_tests).toEqual({ monthly_pitr: null, quarterly_restore: null, annual_drill: null });
    expect(json.data.dr_tests).toEqual([]);
    expect(json.data.backups).toHaveLength(1);
  });

  it('super_admin の一覧の読み取りが error → 500 (本文は汎用・admin_audit_logs を読まない)', async () => {
    mocks.state.superAdminError = { message: RAW_DB_TEXT, code: '42P01' };
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('secret_detail');
    expect(mocks.auditQueries).toHaveLength(0);
  });

  it.each([
    ['取得の最新 (daily)', (calls: RecordedCall[]) => calls.some((c) => c.method === 'eq' && c.args[1] === backupAuditAction('daily', 'completed'))],
    ['取得の最新 (annual)', (calls: RecordedCall[]) => calls.some((c) => c.method === 'eq' && c.args[1] === backupAuditAction('annual', 'completed'))],
    ['訓練の最新 (quarterly_restore)', (calls: RecordedCall[]) => calls.some((c) => c.method === 'eq' && c.args[1] === DR_TEST_AUDIT_ACTIONS.quarterly_restore)],
    ['取得の一覧', (calls: RecordedCall[]) => calls.some((c) => c.method === 'limit' && c.args[0] === BACKUP_STATUS_LIST_LIMIT && calls.some((d) => d.method === 'is'))],
    ['訓練の一覧', (calls: RecordedCall[]) => calls.some((c) => c.method === 'in' && c.args[0] === 'action_type' && JSON.stringify(c.args[1]) === JSON.stringify([...DR_TEST_AUDIT_ACTION_TYPES]))],
  ])('8 本のどれか (%s) が error → 500 (本文は汎用)', async (_label, predicate) => {
    mocks.state.failAuditRead = predicate;
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(json)).not.toContain('secret_detail');
  });

  it('行の検証に落ちる (severity が未知) → 500', async () => {
    mocks.state.auditRows = [{ ...backupRow('daily', HOUR_MS), severity: 'debug' }];
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('INTERNAL_ERROR');
  });

  it('最新 1 行の検証に落ちる (id が uuid でない) → 500', async () => {
    mocks.state.forceLatest[DR_TEST_AUDIT_ACTIONS.monthly_pitr] = { ...drRow('monthly_pitr', HOUR_MS), id: 'not-a-uuid' };
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────

const VALID_BODY = {
  kind: 'quarterly_restore',
  result: 'success',
  performed_on: '2026-10-13',
  environment: 'local',
  restored_to: '2026-10-13T02:23:00+09:00',
  backup_key: 'daily/2026-10-13/homegohan-db-20261012T172300Z.tar.zst.age',
  rto_minutes: 45,
  smoke: 'passed',
  notes: '',
};

function postRequest(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/super-admin/backups/dr-tests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.5, 10.0.0.1',
      'user-agent': 'vitest',
    },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

describe('POST /api/super-admin/backups/dr-tests', () => {
  it('本文に NUL → 400 INVALID_CHARACTER で createClient を呼ばない', async () => {
    const res = await POST(postRequest({ ...VALID_BODY, notes: 'a\u0000b' }));
    expect(res.status).toBe(400);
    // 運営の API のほかの失敗と同じ nested の形 ({ error: { code, message } }。#1917 の続き)
    expect((await res.json()).error.code).toBe('INVALID_CHARACTER');
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.auditInserts).toHaveLength(0);
  });

  it('未ログインは 401・admin は 403 (監査行を書かない)', async () => {
    mocks.state.user = null;
    const unauth = await POST(postRequest(VALID_BODY));
    expect(unauth.status).toBe(401);
    expect((await unauth.json()).error.code).toBe('UNAUTHORIZED');

    loginAs(ADMIN_ID, ['admin']);
    const forbidden = await POST(postRequest(VALID_BODY));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe('FORBIDDEN');
    expect(mocks.auditInserts).toHaveLength(0);
  });

  it('JSON でない → 400 で本文が invalidJsonBodyBody() と同じ (OP_INVALID_INPUT・details [])', async () => {
    const res = await POST(postRequest('{not json', true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalidJsonBodyBody());
    expect(mocks.auditInserts).toHaveLength(0);
  });

  it('kind が未知 → 400 OP_INVALID_INPUT・message「訓練の種類を選んでください」・details[0].path が [kind]', async () => {
    const res = await POST(postRequest({ ...VALID_BODY, kind: 'weekly_pitr' }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(json.error.message).toBe('訓練の種類を選んでください');
    expect(json.error.details[0].path).toEqual(['kind']);
    expect(mocks.auditInserts).toHaveLength(0);
  });

  it('failed で notes 空 → 400・message「失敗・見送りのときは理由を書いてください」・details[0].path が [notes]', async () => {
    const res = await POST(postRequest({ ...VALID_BODY, result: 'failed', notes: '' }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('OP_INVALID_INPUT');
    expect(json.error.message).toBe('失敗・見送りのときは理由を書いてください');
    expect(json.error.details[0].path).toEqual(['notes']);
    expect(mocks.auditInserts).toHaveLength(0);
  });

  it('201 で recordAdminAudit が dr.test.quarterly.restore・target_type dr_test・severity info・details が本文と同じ・request を渡している', async () => {
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true });
    expect(mocks.auditInserts).toHaveLength(1);
    const [insert] = mocks.auditInserts;
    expect(insert).toMatchObject({
      actor_id: SUPER_ADMIN_ID,
      action_type: 'dr.test.quarterly.restore',
      target_id: null,
      target_type: 'dr_test',
      severity: 'info',
      details: VALID_BODY,
    });
    // request を渡しているので、x-forwarded-for の先頭と user-agent が入る
    expect(insert.ip_address).toBe('203.0.113.5');
    expect(insert.user_agent).toBe('vitest');
  });

  it.each([
    ['skipped', 'warn', 'monthly_pitr', 'dr.test.monthly.pitr'],
    ['failed', 'warn', 'annual_drill', 'dr.test.annual.drill'],
  ])('%s は %s (%s → %s)', async (result, severity, kind, action) => {
    const res = await POST(postRequest({ ...VALID_BODY, kind, result, notes: 'plan_not_pro', backup_key: null }));
    expect(res.status).toBe(201);
    expect(mocks.auditInserts[0]).toMatchObject({ action_type: action, severity });
  });

  it('監査行の insert が失敗 → 500 で本文は汎用・201 を返さない (fail-closed)', async () => {
    mocks.state.insertError = { message: RAW_DB_TEXT, code: '42501' };
    const res = await POST(postRequest(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(json)).not.toContain('secret_detail');
  });
});
