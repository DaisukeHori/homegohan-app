/**
 * #1185 返金の記録で使う小さな部品の単体テスト
 *   - src/lib/admin/refund.ts   金額の換算 (画面の入力 <-> Stripe と同じ最小通貨単位の整数)
 *   - src/lib/stripe/links.ts   Stripe ダッシュボードのリンク (本番 / テストモード)
 *   - src/lib/admin/finance-schemas.ts  RefundRequestSchema の出力 (正規化)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFUND_AMOUNT_MAX,
  REFUND_REASON_MAX_LENGTH,
  inputValueToMinor,
  minorToInputValue,
  minorUnitDivisor,
} from '@/lib/admin/refund';
import { getStripeDashboardBase, stripeInvoiceUrl, stripePaymentUrl } from '@/lib/stripe/links';
import { RefundRequestSchema } from '@/lib/admin/finance-schemas';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('minorUnitDivisor (請求書の画面の formatAmount と同じ規則)', () => {
  it('JPY は 1、それ以外は 100。大文字・小文字は区別しない', () => {
    expect(minorUnitDivisor('jpy')).toBe(1);
    expect(minorUnitDivisor('JPY')).toBe(1);
    expect(minorUnitDivisor('usd')).toBe(100);
    expect(minorUnitDivisor('EUR')).toBe(100);
  });
});

describe('minorToInputValue (最小単位 -> 入力欄の文字列)', () => {
  it('JPY は円そのもの', () => {
    expect(minorToInputValue(1200, 'jpy')).toBe('1200');
    expect(minorToInputValue(1, 'JPY')).toBe('1');
  });

  it('JPY 以外は小数 2 桁 (セントの桁を落とさない)', () => {
    expect(minorToInputValue(1234, 'usd')).toBe('12.34');
    expect(minorToInputValue(1200, 'usd')).toBe('12.00');
    expect(minorToInputValue(5, 'usd')).toBe('0.05');
    expect(minorToInputValue(100, 'eur')).toBe('1.00');
  });
});

describe('inputValueToMinor (入力欄の文字列 -> 最小単位)', () => {
  it('JPY は整数だけ読める', () => {
    expect(inputValueToMinor('1200', 'jpy')).toBe(1200);
    expect(inputValueToMinor(' 1200 ', 'JPY')).toBe(1200);
    expect(inputValueToMinor('0', 'jpy')).toBe(0);
    expect(inputValueToMinor('12.5', 'jpy')).toBeNull();
    expect(inputValueToMinor('', 'jpy')).toBeNull();
    expect(inputValueToMinor('abc', 'jpy')).toBeNull();
    expect(inputValueToMinor('-100', 'jpy')).toBeNull();
    expect(inputValueToMinor('1e3', 'jpy')).toBeNull();
  });

  it('全角の数字やカンマ (日本語入力のまま) も読める', () => {
    expect(inputValueToMinor('１２００', 'jpy')).toBe(1200);
    expect(inputValueToMinor('1,200', 'jpy')).toBe(1200);
    expect(inputValueToMinor('１，２００', 'jpy')).toBe(1200);
  });

  it('JPY 以外は小数 2 桁まで。浮動小数点の誤差を出さない (1.005 や 0.1 + 0.2 のような値でも文字列のまま換算)', () => {
    expect(inputValueToMinor('12.34', 'usd')).toBe(1234);
    expect(inputValueToMinor('12', 'usd')).toBe(1200);
    expect(inputValueToMinor('12.3', 'usd')).toBe(1230);
    expect(inputValueToMinor('0.07', 'usd')).toBe(7);
    expect(inputValueToMinor('1.15', 'usd')).toBe(115);
    expect(inputValueToMinor('12.345', 'usd')).toBeNull();
    expect(inputValueToMinor('.5', 'usd')).toBeNull();
    expect(inputValueToMinor('12.', 'usd')).toBeNull();
    expect(inputValueToMinor('-1', 'usd')).toBeNull();
  });

  it('minorToInputValue と往復して元の値に戻る', () => {
    for (const [amount, currency] of [
      [1200, 'jpy'],
      [99_999_999, 'jpy'],
      [1234, 'usd'],
      [5, 'usd'],
      [100, 'eur'],
    ] as const) {
      expect(inputValueToMinor(minorToInputValue(amount, currency), currency)).toBe(amount);
    }
  });

  it('定数: 上限は Stripe の 8 桁、理由は 500 文字', () => {
    expect(REFUND_AMOUNT_MAX).toBe(99_999_999);
    expect(REFUND_REASON_MAX_LENGTH).toBe(500);
  });
});

describe('Stripe ダッシュボードのリンク', () => {
  it('本番ビルド (NODE_ENV=production) は本番モード、それ以外はテストモード (請求書詳細 API と同じ判定)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getStripeDashboardBase()).toBe('https://dashboard.stripe.com');
    expect(stripeInvoiceUrl('in_abc123')).toBe('https://dashboard.stripe.com/invoices/in_abc123');
    expect(stripePaymentUrl('ch_abc123')).toBe('https://dashboard.stripe.com/payments/ch_abc123');

    vi.stubEnv('NODE_ENV', 'development');
    expect(getStripeDashboardBase()).toBe('https://dashboard.stripe.com/test');
    expect(stripeInvoiceUrl('in_abc123')).toBe('https://dashboard.stripe.com/test/invoices/in_abc123');
    expect(stripePaymentUrl('ch_abc123')).toBe('https://dashboard.stripe.com/test/payments/ch_abc123');
  });

  it('ID は URL のパスとして安全な形に変換して埋める', () => {
    expect(stripeInvoiceUrl('in_a/../b?c#d')).toBe(
      'https://dashboard.stripe.com/test/invoices/in_a%2F..%2Fb%3Fc%23d',
    );
  });
});

describe('RefundRequestSchema の出力', () => {
  const base = {
    user_id: '22222222-2222-4222-8222-222222222222',
    stripe_invoice_id: 'in_1MtHbELkdIwHu7ixl4OzzPMv',
    amount: 1200,
    reason: '二重請求',
  };

  it('currency を省略すると JPY、小文字は大文字になる。reason は前後の空白が落ちる', () => {
    const omitted = RefundRequestSchema.parse(base);
    expect(omitted.currency).toBe('JPY');

    const lower = RefundRequestSchema.parse({ ...base, currency: 'usd', reason: '  二重請求  ' });
    expect(lower.currency).toBe('USD');
    expect(lower.reason).toBe('二重請求');
  });

  it('余分なキーは捨てられる (actor_id などを混ぜても出力に残らない)', () => {
    const parsed = RefundRequestSchema.parse({ ...base, actor_id: 'x', severity: 'info' });
    expect(Object.keys(parsed).sort()).toEqual(['amount', 'currency', 'reason', 'stripe_invoice_id', 'user_id']);
  });

  it('決済 ID と請求書 ID の両方がないとき / 両方あるときはエラー (どちらか一方だけ)', () => {
    const neither = RefundRequestSchema.safeParse({ ...base, stripe_invoice_id: undefined });
    const both = RefundRequestSchema.safeParse({ ...base, stripe_charge_id: 'ch_3MmlLrLkdIwHu7ix0snN0B15' });

    expect(neither.success).toBe(false);
    expect(both.success).toBe(false);
    if (!neither.success) {
      expect(neither.error.flatten().fieldErrors.stripe_charge_id).toEqual([
        'stripe_charge_id と stripe_invoice_id はどちらか一方だけを指定してください',
      ]);
    }
  });
});
