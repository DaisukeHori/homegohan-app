/**
 * #2107 (triage-1030c) Y12 のテスト: 会計の一覧の API (売上・請求書・整合チェック) の from / to の検査
 *
 * 以前: RevenueQuerySchema・InvoiceQuerySchema・ReconciliationQuerySchema の from / to は z.string().optional() で、
 * from=not-a-date のような日付・日時でない値をそのまま DB の比較 (gte / lte) に渡し、PostgreSQL の型の誤りで 500 になっていた
 * (tests/integration/operator/admin-finance-detail.test.ts の it.fails で固定していた)。
 * 直したあと: 不正な値はスキーマで弾き、route が DB に触れずに 400 VALIDATION_ERROR「パラメータが不正です (from)」を返す
 * (src/lib/admin/finance-query-errors.ts の financeInvalidQueryResponse。page / per_page の誤りと同じ扱い)。
 *  - 売上 (revenue_snapshots.date は date の列): 実在する日付 (YYYY-MM-DD) だけ
 *  - 請求書 (stripe_webhook_events.received_at)・整合チェック (admin_audit_logs.created_at) は timestamptz の列:
 *    実在する日付 (YYYY-MM-DD) か、タイムゾーンつきの ISO 8601 の日時 (2999-01-01T00:00:00Z など)
 *  - どれも空 (?from=) は今までどおり「その側を絞らない」(undefined)
 */
import { describe, expect, it } from 'vitest';
import { InvoiceQuerySchema, ReconciliationQuerySchema, RevenueQuerySchema } from '@/lib/admin/finance-schemas';
import { financeInvalidQueryMessage, FINANCE_INVALID_QUERY_MESSAGE } from '@/lib/admin/finance-query-errors';

/** 日付・日時として読めない値 (どの一覧でも 400) */
const INVALID_VALUES = [
  'not-a-date',
  '2026-02-30',
  '2026-13-01',
  '2026/10/01',
  '20261001',
  '2026-10-01T25:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-10-01 00:00:00',
  '9999-12-31',
  '0000-01-01T00:00:00Z',
  ' 2026-10-01',
];

/** タイムゾーンつきの ISO 8601 の日時 (timestamptz の列の一覧は通す・date の列の売上は 400) */
const DATETIME_VALUES = ['2999-01-01T00:00:00Z', '2026-10-01T09:00:00+09:00', '2026-10-01T00:00:00.123456+00:00'];

const TIMESTAMP_SCHEMAS = [
  { name: '請求書 (InvoiceQuerySchema)', schema: InvoiceQuerySchema },
  { name: '整合チェック (ReconciliationQuerySchema)', schema: ReconciliationQuerySchema },
] as const;

const ALL_SCHEMAS = [{ name: '売上 (RevenueQuerySchema)', schema: RevenueQuerySchema }, ...TIMESTAMP_SCHEMAS] as const;

describe.each(ALL_SCHEMAS)('#2107 Y12 $name の from / to', ({ schema }) => {
  it.each(INVALID_VALUES)('from=%j は通さず、400 の文は「パラメータが不正です (from)」', (value) => {
    const result = schema.safeParse({ from: value });
    expect(result.success).toBe(false);
    if (!result.success) expect(financeInvalidQueryMessage(result.error.issues)).toBe(`${FINANCE_INVALID_QUERY_MESSAGE} (from)`);
  });

  it.each(INVALID_VALUES)('to=%j は通さず、400 の文は「パラメータが不正です (to)」', (value) => {
    const result = schema.safeParse({ to: value });
    expect(result.success).toBe(false);
    if (!result.success) expect(financeInvalidQueryMessage(result.error.issues)).toBe(`${FINANCE_INVALID_QUERY_MESSAGE} (to)`);
  });

  it('実在する日付 (YYYY-MM-DD) はそのまま通す', () => {
    const result = schema.safeParse({ from: '2026-10-01', to: '2026-10-31' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe('2026-10-01');
      expect(result.data.to).toBe('2026-10-31');
    }
  });

  it('空・無しは「その側を絞らない」(undefined)', () => {
    for (const input of [{ from: '', to: '' }, {}]) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.from).toBeUndefined();
        expect(result.data.to).toBeUndefined();
      }
    }
  });
});

describe.each(TIMESTAMP_SCHEMAS)('#2107 Y12 $name (timestamptz の列) の from / to の日時', ({ schema }) => {
  it.each(DATETIME_VALUES)('タイムゾーンつきの日時 %j はそのまま通す', (value) => {
    const result = schema.safeParse({ from: value, to: value });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe(value);
      expect(result.data.to).toBe(value);
    }
  });
});

describe('#2107 Y12 売上 (RevenueQuerySchema。revenue_snapshots.date は date の列) の from / to の日時', () => {
  it.each(DATETIME_VALUES)('日時 %j は通さない (日付の列には日付だけを渡す)', (value) => {
    expect(RevenueQuerySchema.safeParse({ from: value }).success).toBe(false);
  });
});
