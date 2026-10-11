// @vitest-environment node
//
// #1483: クーポンの有効開始日・有効期限を JST の暦日で扱う回帰テスト。
//
// 以前は運営の画面が `new Date(日付).toISOString()` (UTC の 0 時 = JST 9 時) にして送っていたので、
// 開始日は JST の 9 時まで使えず、期限の日は JST の 9 時で切れていた。
// いまは API が JST の暦日 (YYYY-MM-DD) を受け取り、開始日の JST 0:00・期限の日の JST 23:59:59.999999 にして書く。
//
// 使えるかどうかの判定は DB の関数 apply_coupon (supabase/migrations/20261007160700_apply_coupon_rpc.sql) の
//   `now() < valid_from` → OP_COUPON_NOT_YET_VALID / `now() > valid_until` → OP_COUPON_EXPIRED
// なので、ここでは同じ比べ方を timestamptz と同じマイクロ秒の精度 (tests/helpers/timestamptz.ts の microsOf) で再現して確かめる。
// DB そのもので同じ境目を確かめるのは tests/integration/operator/super-admin-coupons.test.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  couponValidFromTimestamp,
  couponValidityDay,
  couponValidUntilTimestamp,
  isCouponExpiredAt,
} from '@/lib/super-admin/coupon-validity';
import { inEachTimeZone } from './helpers/time-zones';
import { microsOf } from './helpers/timestamptz';

/** apply_coupon の有効性の判定 (2. クーポンの有効性) と同じ比べ方 */
function applyCouponValidity(at: string, validFrom: string, validUntil: string): 'OK' | 'NOT_YET_VALID' | 'EXPIRED' {
  const t = microsOf(at);
  if (t < microsOf(validFrom)) return 'NOT_YET_VALID';
  if (t > microsOf(validUntil)) return 'EXPIRED';
  return 'OK';
}

describe('有効開始日・有効期限の時刻 (JST の暦日 → DB に書く時刻)', () => {
  it('開始日は JST 0:00、期限の日は JST 23:59:59.999999 (実行環境のタイムゾーンに左右されない)', () => {
    for (const { tz, value } of inEachTimeZone(() => ({
      from: couponValidFromTimestamp('2026-10-10'),
      until: couponValidUntilTimestamp('2026-10-20'),
    }))) {
      expect(value.from, tz).toBe('2026-10-09T15:00:00.000Z');
      expect(value.until, tz).toBe('2026-10-20T14:59:59.999999Z');
    }
  });

  it('月末・年末の期限も、その日の JST の終わり', () => {
    expect(couponValidUntilTimestamp('2026-12-31')).toBe('2026-12-31T14:59:59.999999Z');
    expect(couponValidFromTimestamp('2027-01-01')).toBe('2026-12-31T15:00:00.000Z');
  });

  it('存在しない日付・形の違う値は RangeError (API の入口で 400 にするので DB まで届かない)', () => {
    expect(() => couponValidFromTimestamp('2026-02-30')).toThrow(RangeError);
    expect(() => couponValidUntilTimestamp('2026-02-30')).toThrow(RangeError);
    expect(() => couponValidUntilTimestamp('2026-10-20T00:00:00Z')).toThrow(RangeError);
  });
});

describe('apply_coupon と同じ比べ方で、境目の時刻に使えるか (開始日 2026-10-10・期限 2026-10-20)', () => {
  const validFrom = couponValidFromTimestamp('2026-10-10');
  const validUntil = couponValidUntilTimestamp('2026-10-20');

  it.each([
    ['期限の日の 23:59:59 JST は有効', '2026-10-20T14:59:59Z', 'OK'],
    ['期限の日の 23:59:59.999999 JST (その日の最後の瞬間) は有効', '2026-10-20T14:59:59.999999Z', 'OK'],
    ['期限の日の 9:00 JST (以前はここで切れていた) は有効', '2026-10-20T00:00:00Z', 'OK'],
    ['期限の翌日の 0:00 JST は無効 (期限切れ)', '2026-10-20T15:00:00Z', 'EXPIRED'],
    ['開始日の 0:00 JST から有効', '2026-10-09T15:00:00Z', 'OK'],
    ['開始日の 8:59 JST (以前はまだ使えなかった) は有効', '2026-10-09T23:59:00Z', 'OK'],
    ['開始日の前日の 23:59 JST は無効 (開始前)', '2026-10-09T14:59:00Z', 'NOT_YET_VALID'],
    ['開始日の前日の 23:59:59.999999 JST は無効 (開始前)', '2026-10-09T14:59:59.999999Z', 'NOT_YET_VALID'],
  ] as const)('%s', (_label, at, expected) => {
    expect(applyCouponValidity(at, validFrom, validUntil)).toBe(expected);
  });

  it('開始日と期限が同じ日なら、その日の JST 0:00〜23:59:59 だけ使える', () => {
    const from = couponValidFromTimestamp('2026-10-10');
    const until = couponValidUntilTimestamp('2026-10-10');
    expect(applyCouponValidity('2026-10-09T14:59:59Z', from, until)).toBe('NOT_YET_VALID');
    expect(applyCouponValidity('2026-10-09T15:00:00Z', from, until)).toBe('OK');
    expect(applyCouponValidity('2026-10-10T14:59:59Z', from, until)).toBe('OK');
    expect(applyCouponValidity('2026-10-10T15:00:00Z', from, until)).toBe('EXPIRED');
  });
});

describe('isCouponExpiredAt (運営の一覧の期限切れの色。apply_coupon の `now() > valid_until` と同じ)', () => {
  const validUntil = couponValidUntilTimestamp('2026-10-20');

  it('期限の日の 23:59:59 JST はまだ期限内、翌日の 0:00 JST は期限切れ', () => {
    expect(isCouponExpiredAt(validUntil, new Date('2026-10-20T14:59:59.000Z'))).toBe(false);
    expect(isCouponExpiredAt(validUntil, new Date('2026-10-20T14:59:59.999Z'))).toBe(false);
    expect(isCouponExpiredAt(validUntil, new Date('2026-10-20T15:00:00.000Z'))).toBe(true);
  });

  it('DB から読んだ形 (+00:00・小数点以下 6 桁) でも同じ', () => {
    const fromDb = '2026-10-20T14:59:59.999999+00:00';
    expect(isCouponExpiredAt(fromDb, new Date('2026-10-20T14:59:59.999Z'))).toBe(false);
    expect(isCouponExpiredAt(fromDb, new Date('2026-10-20T15:00:00.000Z'))).toBe(true);
  });
});

describe('couponValidityDay (DB の時刻 → 画面に出す JST の暦日)', () => {
  it('書いた時刻を読むと、入力した日付に戻る (実行環境のタイムゾーンに左右されない)', () => {
    for (const { tz, value } of inEachTimeZone(() => ({
      from: couponValidityDay('2026-10-09T15:00:00+00:00'),
      until: couponValidityDay('2026-10-20T14:59:59.999999+00:00'),
    }))) {
      expect(value.from, tz).toBe('2026-10-10');
      expect(value.until, tz).toBe('2026-10-20');
    }
  });

  it('この変更より前に書いた行 (UTC の 0 時 = JST の同じ日の 9 時) も、入力した日付のまま読める', () => {
    expect(couponValidityDay('2026-10-20T00:00:00+00:00')).toBe('2026-10-20');
  });

  it('書いた時刻を読み、もう一度保存しても期限は変わらない (編集画面の保存の往復)', () => {
    const until = couponValidUntilTimestamp('2026-10-20');
    expect(couponValidUntilTimestamp(couponValidityDay(until))).toBe(until);
  });
});

// ---------------------------------------------------------------------------
// API ルート: 日付で受け取り、JST の境目の時刻にして書く
// ---------------------------------------------------------------------------

const mockRequireRole = vi.fn();
const mockCreateClient = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const { POST } = await import('@/app/api/super-admin/coupons/route');
const { PATCH } = await import('@/app/api/super-admin/coupons/[id]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

/** coupons への insert / update と、監査ログへの insert を記録する Supabase クライアントの代わり */
function fakeSupabase() {
  const couponInserts: Record<string, unknown>[] = [];
  const couponUpdates: Record<string, unknown>[] = [];
  const auditInserts: Record<string, unknown>[] = [];
  const singleResult = (data: Record<string, unknown>) => ({
    select: () => ({ single: () => Promise.resolve({ data, error: null }) }),
  });
  const client = {
    from: (table: string) => {
      if (table === 'admin_audit_logs') {
        return {
          insert: (row: Record<string, unknown>) => {
            auditInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          couponInserts.push(row);
          return singleResult({ id: 'coupon-1', ...row });
        },
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: { id: 'coupon-1', code: 'JST1483' }, error: null }) }),
        }),
        update: (row: Record<string, unknown>) => {
          couponUpdates.push(row);
          return { eq: () => singleResult({ id: 'coupon-1', ...row }) };
        },
      };
    },
  };
  return { client, couponInserts, couponUpdates, auditInserts };
}

function jsonRequest(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

const createBody = {
  code: 'JST1483',
  discount_type: 'percentage',
  discount_value: 10,
  valid_from: '2026-10-10',
  valid_until: '2026-10-20',
};

describe('POST /api/super-admin/coupons (#1483 有効開始日・有効期限は JST の暦日)', () => {
  let fake: ReturnType<typeof fakeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(actor);
    fake = fakeSupabase();
    mockCreateClient.mockResolvedValue(fake.client);
  });

  it('開始日の JST 0:00・期限の日の JST 23:59:59.999999 にして書き、監査ログにも同じ時刻を残す', async () => {
    const res = await POST(jsonRequest('http://localhost/api/super-admin/coupons', 'POST', createBody));
    expect(res.status).toBe(201);
    expect(fake.couponInserts).toHaveLength(1);
    expect(fake.couponInserts[0]).toMatchObject({
      valid_from: '2026-10-09T15:00:00.000Z',
      valid_until: '2026-10-20T14:59:59.999999Z',
    });
    expect(fake.auditInserts[0].details).toMatchObject({
      valid_from: '2026-10-09T15:00:00.000Z',
      valid_until: '2026-10-20T14:59:59.999999Z',
    });
  });

  it('開始日と期限が同じ日でも作れる (その日の 1 日だけ使えるクーポン)', async () => {
    const res = await POST(
      jsonRequest('http://localhost/api/super-admin/coupons', 'POST', {
        ...createBody,
        valid_from: '2026-10-10',
        valid_until: '2026-10-10',
      }),
    );
    expect(res.status).toBe(201);
    expect(fake.couponInserts[0]).toMatchObject({
      valid_from: '2026-10-09T15:00:00.000Z',
      valid_until: '2026-10-10T14:59:59.999999Z',
    });
  });

  it.each([
    ['有効開始日が存在しない日付', { valid_from: '2026-02-30' }],
    ['有効期限が存在しない日付', { valid_until: '2026-02-30' }],
    ['有効期限が 2 月 29 日 (平年)', { valid_until: '2027-02-29' }],
    ['有効開始日が日時 (日付ではない)', { valid_from: '2026-10-10T00:00:00Z' }],
    ['有効期限が日時 (日付ではない)', { valid_until: '2026-10-20T23:59:59Z' }],
    ['有効期限が開始日より前', { valid_from: '2026-10-20', valid_until: '2026-10-19' }],
  ])('400 OP_INVALID_INPUT: %s (DB に書かない)', async (_label, override) => {
    const res = await POST(jsonRequest('http://localhost/api/super-admin/coupons', 'POST', { ...createBody, ...override }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OP_INVALID_INPUT');
    expect(fake.couponInserts).toHaveLength(0);
  });
});

describe('PATCH /api/super-admin/coupons/[id] (#1483 有効期限は JST の暦日)', () => {
  let fake: ReturnType<typeof fakeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(actor);
    fake = fakeSupabase();
    mockCreateClient.mockResolvedValue(fake.client);
  });

  it('期限の日の JST 23:59:59.999999 にして書く', async () => {
    const res = await PATCH(
      jsonRequest('http://localhost/api/super-admin/coupons/coupon-1', 'PATCH', { valid_until: '2026-10-31' }),
      { params: { id: 'coupon-1' } },
    );
    expect(res.status).toBe(200);
    expect(fake.couponUpdates).toEqual([{ valid_until: '2026-10-31T14:59:59.999999Z' }]);
  });

  it.each([
    ['存在しない日付', '2026-02-30'],
    ['日時 (日付ではない)', '2026-10-31T00:00:00Z'],
  ])('400 OP_INVALID_INPUT: 有効期限が%s (DB に書かない)', async (_label, validUntil) => {
    const res = await PATCH(
      jsonRequest('http://localhost/api/super-admin/coupons/coupon-1', 'PATCH', { valid_until: validUntil }),
      { params: { id: 'coupon-1' } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OP_INVALID_INPUT');
    expect(fake.couponUpdates).toHaveLength(0);
  });
});
