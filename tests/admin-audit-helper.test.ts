/**
 * #1200 recordAdminAudit (src/lib/admin/audit.ts) の単体テスト
 *
 * 検証観点:
 *  - admin_audit_logs の正しい列 (actor_id など) に 1 行だけ INSERT する
 *  - ip_address は inet 列のため、x-forwarded-for の先頭 1 IP だけを検証して渡す
 *    (複数 IP・不正値をそのまま渡すと INSERT が失敗して監査行ごと失われる)
 *  - INSERT が error を返しても / 例外を投げても、例外は投げず (fail-open)、
 *    db-logger (createLogger().error) に残す
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggerError = vi.fn();
const mockCreateLogger = vi.fn((..._args: unknown[]) => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: (...args: unknown[]) => mockLoggerError(...args),
  withUser: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
}));

const { recordAdminAudit, extractClientIp } = await import('@/lib/admin/audit');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

type InsertResult = { error: { message: string; code?: string } | null };

function makeSupabase(behavior: InsertResult | { throws: Error }) {
  const insert = vi.fn(() =>
    'throws' in behavior ? Promise.reject(behavior.throws) : Promise.resolve(behavior),
  );
  const from = vi.fn(() => ({ insert }));
  return { supabase: { from } as never, from, insert };
}

function requestWith(headers: Record<string, string>) {
  return new Request('http://localhost/api/test', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordAdminAudit: INSERT する内容', () => {
  it('admin_audit_logs に actor_id / action_type / target_id / target_type / details / severity / ip / UA を 1 行入れる', async () => {
    const { supabase, from, insert } = makeSupabase({ error: null });

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      targetId: TARGET_ID,
      targetType: 'user',
      details: { viewed_fields: ['id', 'nickname'] },
      request: requestWith({
        'x-forwarded-for': '203.0.113.7, 70.41.3.18',
        'user-agent': 'Mozilla/5.0 (test)',
      }),
    });

    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('admin_audit_logs');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.view',
      target_id: TARGET_ID,
      target_type: 'user',
      details: { viewed_fields: ['id', 'nickname'] },
      severity: 'info',
      ip_address: '203.0.113.7',
      user_agent: 'Mozilla/5.0 (test)',
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('旧実装の誤った列 admin_id は使わない', async () => {
    const { supabase, insert } = makeSupabase({ error: null });

    await recordAdminAudit({ supabase, actorId: ACTOR_ID, actionType: 'admin.user.view' });

    const row = (insert.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(row).not.toHaveProperty('admin_id');
    expect(row.actor_id).toBe(ACTOR_ID);
  });

  it('省略時の既定値: severity=info / details={} / target と request 由来の列は null', async () => {
    const { supabase, insert } = makeSupabase({ error: null });

    await recordAdminAudit({ supabase, actorId: ACTOR_ID, actionType: 'admin.user.view' });

    expect(insert).toHaveBeenCalledWith({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.view',
      target_id: null,
      target_type: null,
      details: {},
      severity: 'info',
      ip_address: null,
      user_agent: null,
    });
  });

  it('severity を指定できる', async () => {
    const { supabase, insert } = makeSupabase({ error: null });

    await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      severity: 'warn',
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  });

  it('User-Agent は 512 文字で切り詰める', async () => {
    const { supabase, insert } = makeSupabase({ error: null });

    await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      request: requestWith({ 'user-agent': 'a'.repeat(2000) }),
    });

    const row = (insert.mock.calls as unknown as Array<[{ user_agent: string }]>)[0][0];
    expect(row.user_agent).toHaveLength(512);
  });
});

describe('extractClientIp: inet 列に入れられる IP だけを返す', () => {
  it.each([
    ['単一の IPv4', { 'x-forwarded-for': '203.0.113.7' }, '203.0.113.7'],
    ['複数 IP は先頭だけ', { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 10.0.0.1' }, '203.0.113.7'],
    ['前後の空白は除く', { 'x-forwarded-for': '  203.0.113.7 ,70.41.3.18' }, '203.0.113.7'],
    ['IPv6', { 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }, '2001:db8::1'],
    ['IPv4 射影 IPv6', { 'x-forwarded-for': '::ffff:203.0.113.7' }, '::ffff:203.0.113.7'],
    ['x-forwarded-for が無ければ x-real-ip', { 'x-real-ip': '198.51.100.9' }, '198.51.100.9'],
    [
      'x-forwarded-for の先頭が不正なら x-real-ip',
      { 'x-forwarded-for': 'unknown, 203.0.113.7', 'x-real-ip': '198.51.100.9' },
      '198.51.100.9',
    ],
  ])('%s', (_name, headers, expected) => {
    expect(extractClientIp(new Headers(headers))).toBe(expected);
  });

  it.each([
    ['ヘッダ無し', {}],
    ['空文字', { 'x-forwarded-for': '' }],
    ['unknown', { 'x-forwarded-for': 'unknown' }],
    ['ポート付き', { 'x-forwarded-for': '203.0.113.7:4711' }],
    ['CIDR 表記', { 'x-forwarded-for': '203.0.113.0/24' }],
    ['範囲外の IPv4', { 'x-forwarded-for': '999.1.1.1' }],
    ['IPv6 のゾーン ID (inet は受け付けない)', { 'x-forwarded-for': 'fe80::1%eth0' }],
  ])('不正な値は null: %s', (_name, headers) => {
    expect(extractClientIp(new Headers(headers))).toBeNull();
  });

  it('headers が無ければ null', () => {
    expect(extractClientIp(undefined)).toBeNull();
    expect(extractClientIp(null)).toBeNull();
  });

  it('不正な x-forwarded-for でも INSERT 自体は ip_address=null で行われる (監査行を失わない)', async () => {
    const { supabase, insert } = makeSupabase({ error: null });

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      request: requestWith({ 'x-forwarded-for': 'fe80::1%eth0' }),
    });

    expect(result).toEqual({ ok: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ ip_address: null }));
  });
});

describe('recordAdminAudit: 失敗しても例外を投げず (fail-open)、db-logger に残す', () => {
  it('INSERT が error を返したら { ok: false } を返し、createLogger().error で記録する', async () => {
    const { supabase } = makeSupabase({
      error: { message: 'new row violates row-level security policy', code: '42501' },
    });

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
      targetId: TARGET_ID,
      targetType: 'user',
      routeName: 'api/admin/users/[id] GET',
    });

    expect(result).toEqual({ ok: false, error: 'new row violates row-level security policy' });
    expect(mockCreateLogger).toHaveBeenCalledWith('api/admin/users/[id] GET');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mockLoggerError.mock.calls[0];
    expect(message).toContain('監査ログ');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('new row violates row-level security policy');
    expect(metadata).toEqual({
      action_type: 'admin.user.view',
      actor_id: ACTOR_ID,
      target_id: TARGET_ID,
      target_type: 'user',
      error_code: '42501',
    });
  });

  it('INSERT が例外を投げても { ok: false } を返し、記録する (例外を呼び出し元へ伝えない)', async () => {
    const { supabase } = makeSupabase({ throws: new Error('network down') });

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
    });

    expect(result).toEqual({ ok: false, error: 'network down' });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('supabase.from() 自体が例外を投げても { ok: false } を返す', async () => {
    const supabase = {
      from: vi.fn(() => {
        throw new Error('client not initialized');
      }),
    } as never;

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
    });

    expect(result).toEqual({ ok: false, error: 'client not initialized' });
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('Error 以外が throw されても文字列化して記録する', async () => {
    const supabase = {
      from: vi.fn(() => {
        throw 'plain string failure';
      }),
    } as never;

    const result = await recordAdminAudit({
      supabase,
      actorId: ACTOR_ID,
      actionType: 'admin.user.view',
    });

    expect(result).toEqual({ ok: false, error: 'plain string failure' });
  });

  it('routeName 省略時は既定名 admin-audit で記録する', async () => {
    const { supabase } = makeSupabase({ error: { message: 'boom' } });

    await recordAdminAudit({ supabase, actorId: ACTOR_ID, actionType: 'admin.user.view' });

    expect(mockCreateLogger).toHaveBeenCalledWith('admin-audit');
  });

  it('ロガー自体が失敗しても例外を投げない', async () => {
    mockCreateLogger.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    const { supabase } = makeSupabase({ error: { message: 'boom' } });

    await expect(
      recordAdminAudit({ supabase, actorId: ACTOR_ID, actionType: 'admin.user.view' }),
    ).resolves.toEqual({ ok: false, error: 'boom' });
  });
});
