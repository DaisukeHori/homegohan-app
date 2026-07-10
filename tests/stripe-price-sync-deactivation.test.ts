/**
 * #1041 round-4 (C・Critical) 回帰防止 contract テスト
 * supabase/functions/stripe-price-sync/deactivation.ts
 *
 * 従来は旧 Price (`subscription_plans.stripe_price_id` が指す Price) を
 * interval を確認せずに deactivate していたため、以下のシナリオで現役 Price を
 * 無警告で殺す事故が起き得た:
 *   ① 月額のみ変更 → Price A (interval=month) 作成、stripe_price_id=A に更新
 *   ② 後日、年額のみ変更 → Price B (interval=year) 作成
 *      → DB の stripe_price_id (=A, 現役の月額 Price) を interval 確認なしに
 *        deactivate すると、月額課金の実体が消える。
 *
 * 修正後は、旧 Price を Stripe から GET し `recurring.interval` が今回作成した
 * interval と一致する場合のみ deactivate する。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  decideOldPriceDeactivation,
  fetchStripePriceInterval,
  type OldPriceFetchResult,
} from '../supabase/functions/stripe-price-sync/deactivation';

describe('decideOldPriceDeactivation', () => {
  it('oldPriceId が無ければ deactivate しない (no_old_price)', () => {
    const result = decideOldPriceDeactivation({
      oldPriceId: null,
      newPriceId: 'price_new',
      newInterval: 'month',
      oldPriceFetch: { ok: true, interval: 'month' },
    });
    expect(result).toEqual({ deactivate: false, reason: 'no_old_price' });
  });

  it('oldPriceId が今回作成した Price と同じなら deactivate しない (no_old_price)', () => {
    const result = decideOldPriceDeactivation({
      oldPriceId: 'price_same',
      newPriceId: 'price_same',
      newInterval: 'month',
      oldPriceFetch: { ok: true, interval: 'month' },
    });
    expect(result).toEqual({ deactivate: false, reason: 'no_old_price' });
  });

  it('旧 Price の GET に失敗した場合は安全側で deactivate しない (old_price_fetch_failed)', () => {
    const oldPriceFetch: OldPriceFetchResult = { ok: false };
    const result = decideOldPriceDeactivation({
      oldPriceId: 'price_old',
      newPriceId: 'price_new',
      newInterval: 'year',
      oldPriceFetch,
    });
    expect(result).toEqual({ deactivate: false, reason: 'old_price_fetch_failed' });
  });

  it('①→② シナリオ: 旧 Price が month で今回 year を作成した場合、interval 不一致のため deactivate しない', () => {
    // ① 月額変更で作成済みの現役 Price (stripe_price_id が指す Price)
    const oldPriceFetch: OldPriceFetchResult = { ok: true, interval: 'month' };
    // ② 年額のみ変更 → year の新規 Price を作成
    const result = decideOldPriceDeactivation({
      oldPriceId: 'price_month_active',
      newPriceId: 'price_year_new',
      newInterval: 'year',
      oldPriceFetch,
    });
    expect(result).toEqual({ deactivate: false, reason: 'interval_mismatch' });
  });

  it('interval が一致する場合 (通常の同一 interval 変更) は deactivate する', () => {
    const oldPriceFetch: OldPriceFetchResult = { ok: true, interval: 'month' };
    const result = decideOldPriceDeactivation({
      oldPriceId: 'price_month_old',
      newPriceId: 'price_month_new',
      newInterval: 'month',
      oldPriceFetch,
    });
    expect(result).toEqual({ deactivate: true });
  });

  it('旧 Price に recurring.interval が取得できない (null) 場合は deactivate しない (interval_mismatch 扱い)', () => {
    const oldPriceFetch: OldPriceFetchResult = { ok: true, interval: null };
    const result = decideOldPriceDeactivation({
      oldPriceId: 'price_old',
      newPriceId: 'price_new',
      newInterval: 'month',
      oldPriceFetch,
    });
    expect(result).toEqual({ deactivate: false, reason: 'interval_mismatch' });
  });
});

describe('fetchStripePriceInterval', () => {
  it('Stripe から interval=month を取得できる', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'price_old', recurring: { interval: 'month' } }),
    });
    const result = await fetchStripePriceInterval({
      priceId: 'price_old',
      stripeApiBase: 'https://api.stripe.com/v1',
      stripeSecretKey: 'sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, interval: 'month' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/prices/price_old',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('Stripe が非 200 を返した場合は ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('no such price'),
    });
    const result = await fetchStripePriceInterval({
      priceId: 'price_missing',
      stripeApiBase: 'https://api.stripe.com/v1',
      stripeSecretKey: 'sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false });
  });

  it('fetch が例外を投げた場合は ok:false', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await fetchStripePriceInterval({
      priceId: 'price_old',
      stripeApiBase: 'https://api.stripe.com/v1',
      stripeSecretKey: 'sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false });
  });

  it('recurring.interval が month/year 以外なら interval: null を返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'price_old', recurring: { interval: 'week' } }),
    });
    const result = await fetchStripePriceInterval({
      priceId: 'price_old',
      stripeApiBase: 'https://api.stripe.com/v1',
      stripeSecretKey: 'sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, interval: null });
  });

  it('①→② シナリオ (fetch mock 通し検証): year 作成時に旧 Price が month なら、GET → decide の一連の流れで deactivate されない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'price_month_active', recurring: { interval: 'month' } }),
    });
    const oldPriceFetch = await fetchStripePriceInterval({
      priceId: 'price_month_active',
      stripeApiBase: 'https://api.stripe.com/v1',
      stripeSecretKey: 'sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const decision = decideOldPriceDeactivation({
      oldPriceId: 'price_month_active',
      newPriceId: 'price_year_new',
      newInterval: 'year',
      oldPriceFetch,
    });
    expect(decision).toEqual({ deactivate: false, reason: 'interval_mismatch' });
  });
});
