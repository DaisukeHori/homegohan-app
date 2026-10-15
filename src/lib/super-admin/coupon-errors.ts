/**
 * クーポン API (/api/super-admin/coupons と /api/super-admin/coupons/[id]) の 400 OP_INVALID_INPUT の本文を 1 か所で作る (#1534)
 *
 * 以前は POST・PATCH とも、Zod の失敗で `error.message` に `parseResult.error.message` (issues 配列を JSON にした文字列) を入れていた。
 * 一方で PATCH の「有効期限が保存済みの有効開始日より前」(#1510) は定数の文そのものを入れていたため、
 * 同じ誤り (期限の日が開始日より前) でも POST と PATCH で `error.message` の形が違った。画面 (作成・編集) は `error.message` をそのまま出す。
 *
 * ここでは、どの 400 も `error.message` を「最初の issue の文」にし、`details` に issues を全件入れる
 * (src/app/api/super-admin/plans/[id]/price-change/route.ts の firstIssueMessage と同じ形)。
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';

/** 入力の誤りのコード (docs/design/operator/02-api-spec.md §19) */
export const COUPON_INVALID_INPUT_CODE = 'OP_INVALID_INPUT';

/** issues が空のとき (Zod は失敗時に 1 件以上を返すので、通常は使われない) の文 */
export const COUPON_INVALID_INPUT_FALLBACK_MESSAGE = '入力値が不正です';

const HTTP_BAD_REQUEST = 400;

export interface CouponInvalidInputBody {
  error: {
    code: typeof COUPON_INVALID_INPUT_CODE;
    message: string;
    details: readonly z.core.$ZodIssue[];
  };
}

/** 400 の本文。`message` は最初の issue の文、`details` は issues の全件 */
export function couponInvalidInputBody(issues: readonly z.core.$ZodIssue[]): CouponInvalidInputBody {
  return {
    error: {
      code: COUPON_INVALID_INPUT_CODE,
      message: issues[0]?.message ?? COUPON_INVALID_INPUT_FALLBACK_MESSAGE,
      details: issues,
    },
  };
}

/** 400 OP_INVALID_INPUT の応答 */
export function couponInvalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<CouponInvalidInputBody> {
  return NextResponse.json(couponInvalidInputBody(issues), { status: HTTP_BAD_REQUEST });
}
