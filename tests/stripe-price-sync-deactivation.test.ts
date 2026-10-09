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
 *
 * #1102 (オーナー判断 2026-10-08): 価格変更は新規契約だけに適用し、年額用の Stripe Price ID の列
 * (subscription_plans.stripe_yearly_price_id) を足した。stripe_price_id は月額の Price ID。
 * supabase/functions/stripe-price-sync/sync.ts (リクエストの検証 parseSyncRequest と、月額・年額の Price の作成と
 * 旧 Price の無効化 syncPlanPrices) を、Stripe と DB を差し替えて検証する:
 *   - 月額・年額を 1 回の呼び出しで両方受け付け、interval ごとに新しい Price を 1 本ずつ作る
 *   - 旧 Price は同じ interval のものだけを無効化する (deactivation.ts のガードを通す)
 *   - applies_to は new_only のみ (on_renewal / immediately は 400)
 */
import { describe, expect, it, vi } from 'vitest';

import {
  decideOldPriceDeactivation,
  fetchStripePriceInterval,
  type OldPriceFetchResult,
  type StripePriceInterval,
} from '../supabase/functions/stripe-price-sync/deactivation';
import {
  parseSyncRequest,
  syncPlanPrices,
  type CreatePriceResult,
  type SyncDeps,
  type SyncRequest,
} from '../supabase/functions/stripe-price-sync/sync';

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

// ─────────────────────────────────────────────────────────────────────────────
// #1102 parseSyncRequest: リクエストの検証
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSyncRequest (#1102)', () => {
  const base = { plan_id: 'plan-1', stripe_product_id: 'prod_1' };

  it('月額だけ・年額だけ・両方を受け付ける (指定しなかった方は null)', () => {
    expect(parseSyncRequest({ ...base, new_monthly_price_jpy: 1200 })).toEqual({
      ok: true,
      value: expect.objectContaining({ planId: 'plan-1', stripeProductId: 'prod_1', newMonthlyPriceJpy: 1200, newYearlyPriceJpy: null }),
    });
    expect(parseSyncRequest({ ...base, new_yearly_price_jpy: 12000 })).toEqual({
      ok: true,
      value: expect.objectContaining({ newMonthlyPriceJpy: null, newYearlyPriceJpy: 12000 }),
    });
    expect(parseSyncRequest({ ...base, new_monthly_price_jpy: 1200, new_yearly_price_jpy: 12000 })).toEqual({
      ok: true,
      value: expect.objectContaining({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }),
    });
  });

  it('null は「変えない」と同じ扱い。0 円は有効な価格', () => {
    expect(parseSyncRequest({ ...base, new_monthly_price_jpy: null, new_yearly_price_jpy: 0 })).toEqual({
      ok: true,
      value: expect.objectContaining({ newMonthlyPriceJpy: null, newYearlyPriceJpy: 0 }),
    });
  });

  it('plan_key / actor_id / reason は文字列のときだけ引き継ぐ (Stripe Price の metadata 用)', () => {
    const parsed = parseSyncRequest({
      ...base,
      new_monthly_price_jpy: 1200,
      plan_key: 'pro',
      actor_id: 'sa-1',
      reason: '値上げ',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        planId: 'plan-1',
        stripeProductId: 'prod_1',
        newMonthlyPriceJpy: 1200,
        newYearlyPriceJpy: null,
        planKey: 'pro',
        actorId: 'sa-1',
        reason: '値上げ',
      },
    });

    const odd = parseSyncRequest({ ...base, new_monthly_price_jpy: 1200, plan_key: 1, actor_id: {}, reason: null });
    expect(odd).toEqual({
      ok: true,
      value: expect.objectContaining({ planKey: undefined, actorId: undefined, reason: undefined }),
    });
  });

  it.each([undefined, null, 'new_only'])('applies_to=%s は受け付ける (省略・null は new_only 扱い)', (appliesTo) => {
    const parsed = parseSyncRequest({ ...base, new_monthly_price_jpy: 1200, applies_to: appliesTo });
    expect(parsed.ok).toBe(true);
  });

  it.each(['on_renewal', 'immediately', 'everyone', '', 1])(
    'applies_to=%j は 400 (価格変更は新規契約だけ。既存契約へは反映できないので、黙って new_only として処理しない)',
    (appliesTo) => {
      const parsed = parseSyncRequest({ ...base, new_monthly_price_jpy: 1200, applies_to: appliesTo });
      expect(parsed).toEqual({ ok: false, status: 400, error: expect.stringContaining('new_only') });
    },
  );

  it('plan_id / stripe_product_id が無い・文字列でない・空なら 400', () => {
    for (const body of [
      { stripe_product_id: 'prod_1', new_monthly_price_jpy: 1200 },
      { plan_id: '', stripe_product_id: 'prod_1', new_monthly_price_jpy: 1200 },
      { plan_id: 1, stripe_product_id: 'prod_1', new_monthly_price_jpy: 1200 },
    ]) {
      expect(parseSyncRequest(body)).toEqual({ ok: false, status: 400, error: 'plan_id is required' });
    }
    for (const body of [
      { plan_id: 'plan-1', new_monthly_price_jpy: 1200 },
      { plan_id: 'plan-1', stripe_product_id: '', new_monthly_price_jpy: 1200 },
      { plan_id: 'plan-1', stripe_product_id: null, new_monthly_price_jpy: 1200 },
    ]) {
      expect(parseSyncRequest(body)).toEqual({ ok: false, status: 400, error: 'stripe_product_id is required' });
    }
  });

  it('月額も年額も無ければ 400', () => {
    for (const body of [{ ...base }, { ...base, new_monthly_price_jpy: null, new_yearly_price_jpy: null }]) {
      expect(parseSyncRequest(body)).toEqual({
        ok: false,
        status: 400,
        error: expect.stringContaining('少なくとも一方'),
      });
    }
  });

  it.each([
    ['負の値', -1],
    ['小数', 1200.5],
    ['文字列', '1200'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['真偽値', true],
  ])('金額が不正 (%s) なら 400。月額・年額のどちらでも', (_label, value) => {
    const monthly = parseSyncRequest({ ...base, new_monthly_price_jpy: value });
    expect(monthly).toEqual({ ok: false, status: 400, error: expect.stringContaining('new_monthly_price_jpy') });
    const yearly = parseSyncRequest({ ...base, new_yearly_price_jpy: value });
    expect(yearly).toEqual({ ok: false, status: 400, error: expect.stringContaining('new_yearly_price_jpy') });
  });

  it('一方の金額が不正なら、もう一方が有効でも 400 (片方だけ同期しない)', () => {
    expect(parseSyncRequest({ ...base, new_monthly_price_jpy: 1200, new_yearly_price_jpy: -5 }).ok).toBe(false);
  });

  it.each([null, undefined, 'text', 123, ['a']])('ボディがオブジェクトでなければ 400 (%j)', (body) => {
    expect(parseSyncRequest(body)).toEqual({ ok: false, status: 400, error: 'Invalid JSON body' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1102 syncPlanPrices: 月額・年額を 1 回で作り、同じ interval の旧 Price だけを無効化する
// ─────────────────────────────────────────────────────────────────────────────

describe('syncPlanPrices (#1102)', () => {
  /** 旧 Price の ID。Stripe 上の interval は oldIntervals で決める */
  const OLD_MONTH = 'price_old_month';
  const OLD_YEAR = 'price_old_year';

  function request(overrides: Partial<SyncRequest> = {}): SyncRequest {
    return {
      planId: 'plan-1',
      stripeProductId: 'prod_1',
      newMonthlyPriceJpy: null,
      newYearlyPriceJpy: null,
      ...overrides,
    };
  }

  /**
   * Stripe と DB を差し替えた deps。
   * current: DB の現在の Price ID (Error なら読み取り失敗)
   * oldIntervals: 旧 Price ID -> Stripe 上の recurring.interval ({ ok: false } で GET 失敗)
   * createFails: 作成に失敗させる interval
   */
  function makeDeps(opts: {
    current?: { month: string | null; year: string | null } | Error;
    oldIntervals?: Record<string, OldPriceFetchResult>;
    createFails?: StripePriceInterval[];
  } = {}) {
    const current = opts.current ?? { month: OLD_MONTH, year: OLD_YEAR };
    const oldIntervals: Record<string, OldPriceFetchResult> = opts.oldIntervals ?? {
      [OLD_MONTH]: { ok: true, interval: 'month' },
      [OLD_YEAR]: { ok: true, interval: 'year' },
    };
    const createPrice = vi.fn(
      async ({ interval }: { interval: StripePriceInterval; unitAmountJpy: number }): Promise<CreatePriceResult> => {
        if (opts.createFails?.includes(interval)) {
          return { ok: false, status: 400, message: `stripe rejected ${interval}` };
        }
        return { ok: true, id: `price_new_${interval}` };
      },
    );
    const fetchPriceInterval = vi.fn(async (priceId: string): Promise<OldPriceFetchResult> => {
      return oldIntervals[priceId] ?? { ok: false };
    });
    const deactivatePrice = vi.fn(async (_priceId: string): Promise<void> => {});
    const loadCurrentPriceIds = vi.fn(async () => {
      if (current instanceof Error) throw current;
      return current;
    });
    const deps: SyncDeps = { createPrice, fetchPriceInterval, deactivatePrice, loadCurrentPriceIds };
    return { deps, createPrice, fetchPriceInterval, deactivatePrice, loadCurrentPriceIds };
  }

  it('月額・年額を 1 回で両方受け取り、interval ごとに新しい Price を 1 本ずつ作って、同じ interval の旧 Price を無効化する', async () => {
    const m = makeDeps();

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: { new_stripe_price_id: 'price_new_month', deactivated: true },
      year: { new_stripe_price_id: 'price_new_year', deactivated: true },
    });
    // 作る Price は interval ごとに 1 本 (月額 → 年額の順)
    expect(m.createPrice.mock.calls.map((c) => c[0])).toEqual([
      { interval: 'month', unitAmountJpy: 1200 },
      { interval: 'year', unitAmountJpy: 12000 },
    ]);
    // 無効化するのは、同じ interval の旧 Price だけ
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_MONTH, OLD_YEAR]);
    // 旧 Price の ID は DB から 1 回だけ読む
    expect(m.loadCurrentPriceIds).toHaveBeenCalledTimes(1);
  });

  it('月額だけ変える場合は、年額の Price を作らず、年額の旧 Price には触れない (year は null)', async () => {
    const m = makeDeps();

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: { new_stripe_price_id: 'price_new_month', deactivated: true },
      year: null,
    });
    expect(m.createPrice).toHaveBeenCalledTimes(1);
    expect(m.createPrice.mock.calls[0]![0]).toEqual({ interval: 'month', unitAmountJpy: 1200 });
    // 年額の旧 Price は、取得も無効化もしない
    expect(m.fetchPriceInterval.mock.calls.map((c) => c[0])).toEqual([OLD_MONTH]);
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_MONTH]);
  });

  it('年額だけ変える場合は、月額の Price を作らず、月額の旧 Price (現役) を無効化しない (month は null)', async () => {
    const m = makeDeps();

    const outcome = await syncPlanPrices(request({ newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: null,
      year: { new_stripe_price_id: 'price_new_year', deactivated: true },
    });
    expect(m.createPrice).toHaveBeenCalledTimes(1);
    expect(m.createPrice.mock.calls[0]![0]).toEqual({ interval: 'year', unitAmountJpy: 12000 });
    expect(m.fetchPriceInterval.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
    expect(m.deactivatePrice).not.toHaveBeenCalledWith(OLD_MONTH);
  });

  it('旧 Price がまだ無い (列が NULL) interval は、Price を作るだけで無効化しない (no_old_price)。もう一方は無効化する', async () => {
    const m = makeDeps({ current: { month: null, year: OLD_YEAR } });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: { new_stripe_price_id: 'price_new_month', deactivated: false, deactivation_skipped_reason: 'no_old_price' },
      year: { new_stripe_price_id: 'price_new_year', deactivated: true },
    });
    // 旧 Price が無い月額では、Stripe への取得もしない
    expect(m.fetchPriceInterval.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
  });

  it('旧い仕様の「最後に触った側」: 月額の列 (stripe_price_id) に年額の Price が入っていても、月額の変更では無効化しない (interval_mismatch)', async () => {
    // 旧仕様では、年額だけ変えると stripe_price_id が年額の Price を指した。その Price は現役の年額
    const m = makeDeps({
      current: { month: 'price_legacy_year', year: null },
      oldIntervals: { price_legacy_year: { ok: true, interval: 'year' } },
    });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: {
        new_stripe_price_id: 'price_new_month',
        deactivated: false,
        deactivation_skipped_reason: 'interval_mismatch',
      },
      year: null,
    });
    expect(m.deactivatePrice).not.toHaveBeenCalled();
  });

  it('年額の列 (stripe_yearly_price_id) に月額の Price が入っていても、年額の変更では無効化しない (interval_mismatch)', async () => {
    const m = makeDeps({
      current: { month: null, year: 'price_wrong_month' },
      oldIntervals: { price_wrong_month: { ok: true, interval: 'month' } },
    });

    const outcome = await syncPlanPrices(request({ newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: null,
      year: {
        new_stripe_price_id: 'price_new_year',
        deactivated: false,
        deactivation_skipped_reason: 'interval_mismatch',
      },
    });
    expect(m.deactivatePrice).not.toHaveBeenCalled();
  });

  it('interval ごとに判定する: 月額の旧 Price が年額の Price だった場合は月額だけ無効化せず、年額は無効化する', async () => {
    const m = makeDeps({
      current: { month: 'price_legacy_year', year: OLD_YEAR },
      oldIntervals: {
        price_legacy_year: { ok: true, interval: 'year' },
        [OLD_YEAR]: { ok: true, interval: 'year' },
      },
    });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toMatchObject({
      ok: true,
      month: { deactivated: false, deactivation_skipped_reason: 'interval_mismatch' },
      year: { deactivated: true },
    });
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
  });

  it('旧 Price の取得 (Stripe の GET) に失敗した interval は、安全側で無効化しない (old_price_fetch_failed)。もう一方には影響しない', async () => {
    const m = makeDeps({
      oldIntervals: { [OLD_MONTH]: { ok: false }, [OLD_YEAR]: { ok: true, interval: 'year' } },
    });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toMatchObject({
      ok: true,
      month: { new_stripe_price_id: 'price_new_month', deactivated: false, deactivation_skipped_reason: 'old_price_fetch_failed' },
      year: { new_stripe_price_id: 'price_new_year', deactivated: true },
    });
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual([OLD_YEAR]);
  });

  it('DB から旧 Price の ID を読めなかったときは、新しい Price は返すが、旧 Price は 1 本も無効化しない (old_price_fetch_failed)', async () => {
    const m = makeDeps({ current: new Error('column does not exist') });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({
      ok: true,
      month: { new_stripe_price_id: 'price_new_month', deactivated: false, deactivation_skipped_reason: 'old_price_fetch_failed' },
      year: { new_stripe_price_id: 'price_new_year', deactivated: false, deactivation_skipped_reason: 'old_price_fetch_failed' },
    });
    expect(m.fetchPriceInterval).not.toHaveBeenCalled();
    expect(m.deactivatePrice).not.toHaveBeenCalled();
  });

  it('旧 Price の ID が新しい Price と同じなら無効化しない (no_old_price)', async () => {
    const m = makeDeps({ current: { month: 'price_new_month', year: null } });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200 }), m.deps);

    expect(outcome).toMatchObject({
      ok: true,
      month: { deactivated: false, deactivation_skipped_reason: 'no_old_price' },
    });
    expect(m.deactivatePrice).not.toHaveBeenCalled();
  });

  it('年額の Price の作成に失敗したら 502 を返し、すでに作った月額の新しい Price を無効化して、旧 Price には一切触れない', async () => {
    const m = makeDeps({ createFails: ['year'] });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({ ok: false, status: 502, error: expect.stringContaining('年額') });
    expect(outcome.ok === false && outcome.error).toContain('stripe rejected year');
    // 作ったばかりの月額の Price (誰も参照しない) だけを無効化する。旧 Price (現役) は無効化しない
    expect(m.deactivatePrice.mock.calls.map((c) => c[0])).toEqual(['price_new_month']);
    expect(m.loadCurrentPriceIds).not.toHaveBeenCalled();
    expect(m.fetchPriceInterval).not.toHaveBeenCalled();
  });

  it('月額の Price の作成に失敗したら 502 を返し、年額の Price は作らず、何も無効化しない', async () => {
    const m = makeDeps({ createFails: ['month'] });

    const outcome = await syncPlanPrices(request({ newMonthlyPriceJpy: 1200, newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toEqual({ ok: false, status: 502, error: expect.stringContaining('月額') });
    expect(m.createPrice).toHaveBeenCalledTimes(1);
    expect(m.deactivatePrice).not.toHaveBeenCalled();
    expect(m.loadCurrentPriceIds).not.toHaveBeenCalled();
  });

  it('1 本だけ変える場合に作成が失敗したら 502 (旧 Price には触れない)', async () => {
    const m = makeDeps({ createFails: ['year'] });

    const outcome = await syncPlanPrices(request({ newYearlyPriceJpy: 12000 }), m.deps);

    expect(outcome).toMatchObject({ ok: false, status: 502 });
    expect(m.deactivatePrice).not.toHaveBeenCalled();
  });
});
