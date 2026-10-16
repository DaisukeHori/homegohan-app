/**
 * #1129 public.record_backup_audit (migration *_backup_audit_record.sql) の実 DB の振る舞い (ローカルの Supabase)。
 * 設計 docs/design/cross/17-backup-automation.md §5.2・§15。
 *
 * 確かめること:
 *   - 所有者 postgres (postgres-meta の /pg/query) が呼ぶと admin_audit_logs に 1 行 (actor_id NULL・target_type database_backup・
 *     completed は info / failed は warn)
 *   - 未知の action_type・配列の details・上限 (8192 bytes) を超える details は 22023 で止まる (行を作らない)
 *   - service_role・anon は関数を呼べない (42501)
 *   - authenticated の super_admin は、関数が作った行を UPDATE / DELETE できない (RLS の USING (false) で 0 行)。
 *     postgres は RLS を越えるので消せる (この表の不変はアプリのロールにだけ効く。後片付けを兼ねる)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/backup-audit-record.test.ts
 * 本番には接続しない。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

import { cleanupTestUser, createTestUserWithRoles, testEmail, type TestUser } from '../helpers/users';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

/** migration の record_backup_audit の details の上限 (bytes)。scripts/lib/backup-db.mjs の AUDIT_DETAILS_MAX_BYTES と同じ */
const DETAILS_MAX_BYTES = 8192;
/** ローカルスタックの Kong -> PostgREST が最初の 1 回だけ 502 を返すことがある。DB の結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
const RETRY_WAIT_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url as string, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}

/** postgres-meta で SQL を postgres として流す (最後の文の行が返る)。失敗は本文つきで投げる */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey as string, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES) {
      await sleep(RETRY_WAIT_MS * (attempt + 1));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
    return body as T[];
  }
}

const sqlLiteral = (text: string) => `'${text.replace(/'/g, "''")}'`;
const RUN_MARK = `it-${Date.now()}`;

async function recordAudit(actionType: string, details: unknown): Promise<string> {
  const rows = await pgQuery<{ id: string }>(
    `SELECT public.record_backup_audit(${sqlLiteral(actionType)}, ${sqlLiteral(JSON.stringify(details))}::jsonb) AS id;`,
  );
  return rows[0].id;
}

async function rowById(id: string) {
  const rows = await pgQuery<{ actor_id: string | null; severity: string; target_type: string; action_type: string; details: Record<string, unknown> }>(
    `SELECT actor_id, severity, target_type, action_type, details FROM public.admin_audit_logs WHERE id = ${sqlLiteral(id)};`,
  );
  return rows[0];
}

const createdIds: string[] = [];
let superAdmin: TestUser;

beforeAll(async () => {
  superAdmin = await createTestUserWithRoles({ email: testEmail('super_admin-backup', Date.now()), roles: ['super_admin'] });
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await pgQuery(`DELETE FROM public.admin_audit_logs WHERE id IN (${createdIds.map(sqlLiteral).join(', ')});`);
  }
  if (superAdmin) await cleanupTestUser(superAdmin.userId);
});

describe('record_backup_audit (postgres = 取得の経路)', () => {
  it('backup.daily.completed が行を作る: actor_id NULL・severity info・target_type database_backup', async () => {
    const id = await recordAudit('backup.daily.completed', { tier: 'daily', mark: RUN_MARK });
    createdIds.push(id);
    expect(await rowById(id)).toMatchObject({
      actor_id: null, severity: 'info', target_type: 'database_backup', action_type: 'backup.daily.completed', details: { tier: 'daily', mark: RUN_MARK },
    });
  });

  it('.failed は warn', async () => {
    const id = await recordAudit('backup.weekly.failed', { tier: 'weekly', stage: 'copy', mark: RUN_MARK });
    createdIds.push(id);
    expect((await rowById(id)).severity).toBe('warn');
  });

  it('未知の action_type・配列の details・上限を超える details は 22023 (invalid / object / too large) で行を作らない', async () => {
    const before = await pgQuery<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit_logs WHERE details->>'mark' = ${sqlLiteral(RUN_MARK)};`);
    await expect(recordAudit('backup.monthly.completed', { mark: RUN_MARK })).rejects.toThrow(/invalid action_type/);
    await expect(recordAudit('backup.daily.completed', [RUN_MARK])).rejects.toThrow(/details must be an object/);
    await expect(recordAudit('backup.daily.completed', { mark: RUN_MARK, pad: 'x'.repeat(DETAILS_MAX_BYTES + 1) })).rejects.toThrow(/details too large/);
    const after = await pgQuery<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit_logs WHERE details->>'mark' = ${sqlLiteral(RUN_MARK)};`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('関数は SECURITY INVOKER で、API のロールに EXECUTE が無い', async () => {
    const rows = await pgQuery<{ definer: boolean; anon: boolean; authed: boolean; service: boolean }>(
      "SELECT p.prosecdef AS definer, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'record_backup_audit';",
    );
    expect(rows).toEqual([{ definer: false, anon: false, authed: false, service: false }]);
  });
});

describe('record_backup_audit をアプリのロールから', () => {
  it('service_role と anon は rpc を呼べない (42501)', async () => {
    for (const [label, db] of [['service_role', client(serviceKey)], ['anon', client(anonKey)]] as const) {
      const { error } = await db.rpc('record_backup_audit', { p_action_type: 'backup.daily.completed', p_details: { mark: RUN_MARK } });
      expect(error?.code, label).toBe('42501');
    }
  });

  it('super_admin は関数が作った行を UPDATE / DELETE できず (0 行)、postgres は消せる', async () => {
    const id = await recordAudit('backup.annual.completed', { tier: 'annual', mark: RUN_MARK });
    const db = client(anonKey, superAdmin.jwt);
    const updated = await db.from('admin_audit_logs').update({ severity: 'critical' }).eq('id', id).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([]);
    const deleted = await db.from('admin_audit_logs').delete().eq('id', id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([]);
    const reread = await client(serviceKey).from('admin_audit_logs').select('severity').eq('id', id).single();
    expect(reread.data).toEqual({ severity: 'info' });
    const removed = await pgQuery<{ id: string }>(`DELETE FROM public.admin_audit_logs WHERE id = ${sqlLiteral(id)} RETURNING id;`);
    expect(removed).toEqual([{ id }]);
  });
});
