/**
 * #1041 (F4-07) / #1224 回帰防止テスト
 * src/lib/plan/coupon.ts — クーポン適用 (DB 関数 apply_coupon の呼び出しと、業務エラーの CouponApplyError への変換)
 *
 * #1224: 検証・per_user_limit / 組織上限 / max_uses の判定・uses_count の加算・旧 redemption の終了・
 * 新規 redemption の作成・契約の参照更新を、DB 関数 apply_coupon の 1 トランザクションに移した
 * (以前は TS から PostgREST を何度も呼ぶ check-then-act で、同時に来ると上限を超えて適用できた)。
 * TS 側は RPC の呼び出しとエラー変換だけを持つので、ここではその薄い層を検証する。
 * 業務ルールそのもの (競合・原子性・検証の順序・割引額) は、実 DB に対する結合テスト
 * tests/integration/rls/coupon-apply-rpc.test.ts で検証している。
 */
import { describe, expect, it } from 'vitest';
import { applyCoupon, CouponApplyError } from '@/lib/plan/coupon';
import { createFakeSupabase } from './helpers/fake-supabase';

const params = {
  couponId: 'coupon-1',
  subscriptionTarget: 'personal' as const,
  subscriptionId: 'sub-1',
  approvedBy: 'admin-1',
};

/** PostgREST が返す RPC エラーの形 (RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001', DETAIL = '<種別>') */
function rpcError(message: string, details: string | null = null, code = 'P0001') {
  return { code, message, details, hint: null };
}

describe('applyCoupon (apply_coupon RPC の呼び出し)', () => {
  it('apply_coupon を正しい引数で 1 回だけ呼び、結果を返す。テーブルを直接読み書きしない (check-then-act に戻さない)', async () => {
    const supabase = createFakeSupabase({}, [
      { data: { redemption_id: 'redemption-1', discount_amount_jpy: 300, duration_months: 3 }, error: null },
    ]);

    const result = await applyCoupon(supabase as never, params);

    expect(result).toEqual({ redemptionId: 'redemption-1', discountAmountJpy: 300, durationMonths: 3 });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('apply_coupon', {
      p_coupon_id: 'coupon-1',
      p_target: 'personal',
      p_subscription_id: 'sub-1',
      p_approved_by: 'admin-1',
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('組織宛はそのまま p_target=org で渡す', async () => {
    const supabase = createFakeSupabase({}, [
      { data: { redemption_id: 'redemption-2', discount_amount_jpy: 0, duration_months: null }, error: null },
    ]);

    const result = await applyCoupon(supabase as never, { ...params, subscriptionTarget: 'org', subscriptionId: 'org-1' });

    expect(result).toEqual({ redemptionId: 'redemption-2', discountAmountJpy: 0, durationMonths: null });
    expect(supabase.rpc).toHaveBeenCalledWith('apply_coupon', expect.objectContaining({ p_target: 'org', p_subscription_id: 'org-1' }));
  });

  it('duration_months が無い (null / 欠損) 結果は durationMonths=null', async () => {
    const supabase = createFakeSupabase({}, [
      { data: { redemption_id: 'redemption-3', discount_amount_jpy: 100 }, error: null },
    ]);

    await expect(applyCoupon(supabase as never, params)).resolves.toEqual({
      redemptionId: 'redemption-3',
      discountAmountJpy: 100,
      durationMonths: null,
    });
  });
});

describe('applyCoupon (業務エラーの変換: 従来の CouponApplyError のコードと文言を保つ)', () => {
  const cases: Array<{ message: string; details: string | null; code: string; text: string }> = [
    { message: 'OP_COUPON_NOT_FOUND', details: null, code: 'OP_COUPON_NOT_FOUND', text: 'クーポンが見つかりません' },
    { message: 'OP_COUPON_INVALID', details: null, code: 'OP_COUPON_INVALID', text: 'クーポンが有効な状態ではありません' },
    { message: 'OP_COUPON_NOT_YET_VALID', details: null, code: 'OP_COUPON_NOT_YET_VALID', text: 'クーポンの有効開始日前です' },
    { message: 'OP_COUPON_EXPIRED', details: null, code: 'OP_COUPON_EXPIRED', text: 'クーポンの有効期限が切れています' },
    { message: 'OP_COUPON_NOT_APPLICABLE', details: 'target', code: 'OP_COUPON_NOT_APPLICABLE', text: 'このクーポンは指定の契約種別には適用できません' },
    { message: 'OP_COUPON_NOT_APPLICABLE', details: 'plan', code: 'OP_COUPON_NOT_APPLICABLE', text: 'このクーポンは対象プランに適用できません' },
    { message: 'OP_SUBSCRIPTION_NOT_FOUND', details: 'personal', code: 'OP_SUBSCRIPTION_NOT_FOUND', text: '契約が見つかりません' },
    { message: 'OP_SUBSCRIPTION_NOT_FOUND', details: 'org', code: 'OP_SUBSCRIPTION_NOT_FOUND', text: '契約 (組織) が見つかりません' },
    { message: 'OP_PLAN_NOT_FOUND', details: 'org_plan_unset', code: 'OP_PLAN_NOT_FOUND', text: '組織に契約プランが設定されていません' },
    { message: 'OP_PLAN_NOT_FOUND', details: 'plan', code: 'OP_PLAN_NOT_FOUND', text: '契約先プランが見つかりません' },
    { message: 'OP_COUPON_LIMIT_REACHED', details: 'per_user', code: 'OP_COUPON_LIMIT_REACHED', text: 'このユーザーはクーポンの利用上限に達しています' },
    { message: 'OP_COUPON_LIMIT_REACHED', details: 'per_organization', code: 'OP_COUPON_LIMIT_REACHED', text: 'この組織はクーポンの利用上限に達しています' },
    { message: 'OP_COUPON_LIMIT_REACHED', details: 'max_uses', code: 'OP_COUPON_LIMIT_REACHED', text: 'クーポンの利用上限に達しています' },
  ];

  it.each(cases)('$message ($details) -> CouponApplyError($code, $text)', async ({ message, details, code, text }) => {
    const supabase = createFakeSupabase({}, [{ data: null, error: rpcError(message, details) }]);

    const promise = applyCoupon(supabase as never, params);

    await expect(promise).rejects.toBeInstanceOf(CouponApplyError);
    await expect(promise).rejects.toMatchObject({ code, message: text });
  });

  it('DETAIL が無い・未知の種別でも、そのコードの既定の文言で CouponApplyError にする', async () => {
    const noDetail = createFakeSupabase({}, [{ data: null, error: rpcError('OP_COUPON_LIMIT_REACHED') }]);
    await expect(applyCoupon(noDetail as never, params)).rejects.toMatchObject({
      code: 'OP_COUPON_LIMIT_REACHED',
      message: 'クーポンの利用上限に達しています',
    });

    const unknownDetail = createFakeSupabase({}, [{ data: null, error: rpcError('OP_COUPON_NOT_APPLICABLE', 'something_new') }]);
    await expect(applyCoupon(unknownDetail as never, params)).rejects.toMatchObject({
      code: 'OP_COUPON_NOT_APPLICABLE',
      message: 'このクーポンは指定の契約種別には適用できません',
    });
  });
});

describe('applyCoupon (業務エラー以外はそのまま投げる = route が 500 にする)', () => {
  it('外部キー違反などの DB エラーは変換せず、同じオブジェクトを投げる', async () => {
    const error = rpcError('insert or update on table "coupon_redemptions" violates foreign key constraint', null, '23503');
    const supabase = createFakeSupabase({}, [{ data: null, error }]);

    const promise = applyCoupon(supabase as never, params);

    await expect(promise).rejects.toBe(error);
    await expect(promise).rejects.not.toBeInstanceOf(CouponApplyError);
  });

  it('関数が無い (PGRST202) 場合も変換しない (migration の反映漏れを業務エラーと取り違えない)', async () => {
    const error = rpcError('Could not find the function public.apply_coupon(...) in the schema cache', null, 'PGRST202');
    const supabase = createFakeSupabase({}, [{ data: null, error }]);

    await expect(applyCoupon(supabase as never, params)).rejects.toBe(error);
  });

  it('P0001 でも未知のメッセージ (ほかのトリガー等が出したもの) は業務エラーにしない', async () => {
    const error = rpcError('SOME_OTHER_ERROR');
    const supabase = createFakeSupabase({}, [{ data: null, error }]);

    await expect(applyCoupon(supabase as never, params)).rejects.toBe(error);
  });

  it('業務エラーのコードと同じメッセージでも、P0001 以外の SQLSTATE なら業務エラーにしない', async () => {
    const error = rpcError('OP_COUPON_EXPIRED', null, '42501');
    const supabase = createFakeSupabase({}, [{ data: null, error }]);

    await expect(applyCoupon(supabase as never, params)).rejects.toBe(error);
  });

  it('Object のプロパティ名と同じメッセージ (toString 等) でも業務エラーとして扱わない', async () => {
    const error = rpcError('toString');
    const supabase = createFakeSupabase({}, [{ data: null, error }]);

    await expect(applyCoupon(supabase as never, params)).rejects.toBe(error);
  });

  it.each([
    ['null', null],
    ['redemption_id が無い', { discount_amount_jpy: 300 }],
    ['discount_amount_jpy が数値でない', { redemption_id: 'r-1', discount_amount_jpy: '300' }],
  ])('想定外の戻り値 (%s) は Error', async (_label, data) => {
    const supabase = createFakeSupabase({}, [{ data, error: null }]);

    await expect(applyCoupon(supabase as never, params)).rejects.toThrow('apply_coupon が想定外の結果を返しました');
  });
});
