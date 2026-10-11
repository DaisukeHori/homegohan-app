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
  couponValidUntilPatchValue,
  couponValidUntilTimestamp,
  isCouponExpiredAt,
} from '@/lib/super-admin/coupon-validity';
import { inEachTimeZone, TEST_TIME_ZONES } from './helpers/time-zones';
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

describe('couponValidUntilPatchValue (詳細の画面の保存で送る有効期限)', () => {
  it('日付を変えていなければ送らない (以前に書いた行・新しい行のどちらも)', () => {
    expect(couponValidUntilPatchValue('2026-10-20', '2026-10-20T00:00:00+00:00')).toBeUndefined();
    expect(couponValidUntilPatchValue('2026-10-20', '2026-10-20T14:59:59.999999+00:00')).toBeUndefined();
  });

  it('日付を変えたら、その日付を送る', () => {
    expect(couponValidUntilPatchValue('2026-10-21', '2026-10-20T00:00:00+00:00')).toBe('2026-10-21');
    expect(couponValidUntilPatchValue('2026-10-19', '2026-10-20T14:59:59.999999+00:00')).toBe('2026-10-19');
  });

  it('編集欄を空にしたら空のまま送る (API が 400 にして、画面に理由を出す)', () => {
    expect(couponValidUntilPatchValue('', '2026-10-20T14:59:59.999999+00:00')).toBe('');
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

/** PATCH が読む保存済みの有効開始日 (既定は 2026-10-10 の JST 0:00 = POST で開始日 2026-10-10 として書いた時刻) */
const STORED_VALID_FROM = '2026-10-09T15:00:00+00:00';

/** coupons への insert / update と、監査ログへの insert を記録する Supabase クライアントの代わり */
function fakeSupabase(storedValidFrom: string = STORED_VALID_FROM) {
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
          eq: () => ({
            single: () =>
              Promise.resolve({ data: { id: 'coupon-1', code: 'JST1483', valid_from: storedValidFrom }, error: null }),
          }),
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

/**
 * #1510: PATCH は保存済みの有効開始日 (valid_from) と、新しい有効期限 (valid_until) の前後を比べる。
 * 以前は比べず、開始日より前の期限に変えられた (一度も使えないクーポンになる)。
 * POST と同じく JST の暦日で比べ、期限の日が開始日より前なら 400 OP_INVALID_INPUT・同じ日は可。valid_until を送らないときは比べない。
 */
describe('PATCH /api/super-admin/coupons/[id] (#1510 有効期限と保存済みの有効開始日の前後)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(actor);
  });

  async function patch(storedValidFrom: string, body: Record<string, unknown>) {
    const fake = fakeSupabase(storedValidFrom);
    mockCreateClient.mockResolvedValue(fake.client);
    const res = await PATCH(jsonRequest('http://localhost/api/super-admin/coupons/coupon-1', 'PATCH', body), {
      params: { id: 'coupon-1' },
    });
    return { res, fake };
  }

  it('期限の日が開始日の前日なら 400 OP_INVALID_INPUT (DB にも監査ログにも書かない)', async () => {
    const { res, fake } = await patch(STORED_VALID_FROM, { valid_until: '2026-10-09' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; details: { path: string[] }[] } };
    expect(body.error.code).toBe('OP_INVALID_INPUT');
    expect(body.error.message).toBe('有効終了日は有効開始日と同じ日かそれより後にしてください');
    expect(body.error.details[0].path).toEqual(['valid_until']);
    expect(fake.couponUpdates).toHaveLength(0);
    expect(fake.auditInserts).toHaveLength(0);
  });

  it('期限の日が開始日と同じ日なら変えられる (その日の 1 日だけ使えるクーポン。POST と同じ)', async () => {
    const { res, fake } = await patch(STORED_VALID_FROM, { valid_until: '2026-10-10' });
    expect(res.status).toBe(200);
    expect(fake.couponUpdates).toEqual([{ valid_until: '2026-10-10T14:59:59.999999Z' }]);
  });

  it('開始日は UTC の暦日でなく JST の暦日で比べる (開始日の JST 0:00 は UTC では前日の 15:00)', async () => {
    // 保存済みの valid_from の UTC の暦日は 2026-10-09。UTC で比べると 2026-10-09 の期限が通ってしまう
    const { res, fake } = await patch('2026-10-09T15:00:00.000Z', { valid_until: '2026-10-09' });
    expect(res.status).toBe(400);
    expect(fake.couponUpdates).toHaveLength(0);
  });

  it('#1483 より前に書いた行 (開始日の UTC 0 時 = JST 9 時) も、入力した開始日の JST の暦日で比べる', async () => {
    const before = await patch('2026-10-10T00:00:00+00:00', { valid_until: '2026-10-09' });
    expect(before.res.status).toBe(400);
    expect(before.fake.couponUpdates).toHaveLength(0);

    const sameDay = await patch('2026-10-10T00:00:00+00:00', { valid_until: '2026-10-10' });
    expect(sameDay.res.status).toBe(200);
    expect(sameDay.fake.couponUpdates).toEqual([{ valid_until: '2026-10-10T14:59:59.999999Z' }]);
  });

  it('valid_until を送らないときは比べない (表示名だけの変更は、開始日に関係なく通る)', async () => {
    const { res, fake } = await patch('2099-01-01T00:00:00+00:00', { display_name: '名前だけ変える' });
    expect(res.status).toBe(200);
    expect(fake.couponUpdates).toEqual([{ display_name: '名前だけ変える' }]);
  });

  it('実行環境のタイムゾーンに左右されない (どの TZ でも開始日の前日は 400・同じ日は 200)', async () => {
    const results: { tz: string; before: number; same: number }[] = [];
    // ルートは await のあとで日付を比べるので、withTimeZone (同期の関数用) でなく、await のあいだも TZ を切り替えたままにする
    for (const tz of TEST_TIME_ZONES) {
      const saved = process.env.TZ;
      process.env.TZ = tz;
      try {
        const before = await patch(STORED_VALID_FROM, { valid_until: '2026-10-09' });
        const same = await patch(STORED_VALID_FROM, { valid_until: '2026-10-10' });
        results.push({ tz, before: before.res.status, same: same.res.status });
      } finally {
        if (saved === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = saved;
        }
      }
    }
    expect(results).toHaveLength(TEST_TIME_ZONES.length);
    for (const r of results) {
      expect(r.before, r.tz).toBe(400);
      expect(r.same, r.tz).toBe(200);
    }
  });
});
