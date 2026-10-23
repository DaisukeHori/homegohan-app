/**
 * クーポン API の 400 (入力の誤り OP_INVALID_INPUT・クエリの誤り OP_INVALID_QUERY) の本文を 1 か所で作る (#1534 / #1641)
 *
 * 対象の route:
 *   - OP_INVALID_INPUT: POST /api/super-admin/coupons・PATCH /api/super-admin/coupons/[id]・POST /api/super-admin/coupons/[id]/apply
 *   - OP_INVALID_QUERY: GET /api/super-admin/coupons・GET /api/super-admin/coupons/[id]/redemptions
 *
 * 以前は Zod の失敗で、応答の `error.message` に ZodError の `message` (issues 配列を JSON にした文字列) を入れていた。
 * 一方で PATCH の「有効期限が保存済みの有効開始日より前」(#1510) は定数の文そのものを入れていたため、
 * 同じ誤り (期限の日が開始日より前) でも POST と PATCH で `error.message` の形が違った。画面 (作成・編集) は `error.message` をそのまま出す。
 * apply (#1641) とクエリの 400 (#1641) も同じく直列化した文字列を入れ、クエリの 400 は `details` も付けていなかった。
 *
 * ここでは、どの 400 も `error.message` を「最初の issue の文」にし、`details` に issues を全件入れる
 * (src/lib/super-admin/validation-errors.ts の validationErrorBody と同じ形。#1917 から、Zod の既定の英語の文は日本語の固定の文にする)。
 *
 * #1654: 実体は super-admin 全体で使う src/lib/super-admin/validation-errors.ts に移した。
 * ここはクーポン向けの名前で再公開しているだけで、本文の形・文・コードは変わらない。
 */
import type { NextResponse } from 'next/server';
import type { z } from 'zod';
import {
  SUPER_ADMIN_INVALID_INPUT_CODE,
  SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE,
  SUPER_ADMIN_INVALID_QUERY_CODE,
  SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE,
  invalidInputBody,
  invalidInputResponse,
  invalidQueryBody,
  invalidQueryResponse,
  validationErrorBody,
  validationErrorResponse,
  type SuperAdminInvalidInputBody,
  type SuperAdminInvalidQueryBody,
  type SuperAdminValidationErrorBody,
  type SuperAdminValidationErrorCode,
} from './validation-errors';

/** 入力の誤りのコード (docs/design/operator/02-api-spec.md §19) */
export const COUPON_INVALID_INPUT_CODE = SUPER_ADMIN_INVALID_INPUT_CODE;

/** クエリの誤りのコード (docs/design/operator/02-api-spec.md §19) */
export const COUPON_INVALID_QUERY_CODE = SUPER_ADMIN_INVALID_QUERY_CODE;

/** 400 の本文に使えるコード */
export type CouponValidationErrorCode = SuperAdminValidationErrorCode;

/** issues が空のとき (Zod は失敗時に 1 件以上を返すので、通常は使われない) の文 (OP_INVALID_INPUT) */
export const COUPON_INVALID_INPUT_FALLBACK_MESSAGE = SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE;

/** issues が空のとき (同上) の文 (OP_INVALID_QUERY) */
export const COUPON_INVALID_QUERY_FALLBACK_MESSAGE = SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE;

export type CouponValidationErrorBody<C extends CouponValidationErrorCode = CouponValidationErrorCode> =
  SuperAdminValidationErrorBody<C>;

/** 400 OP_INVALID_INPUT の本文の型 */
export type CouponInvalidInputBody = SuperAdminInvalidInputBody;

/** 400 OP_INVALID_QUERY の本文の型 */
export type CouponInvalidQueryBody = SuperAdminInvalidQueryBody;

/** 400 の本文。`message` は最初の issue の文、`details` は issues の全件 */
export function couponValidationErrorBody<C extends CouponValidationErrorCode>(
  code: C,
  issues: readonly z.core.$ZodIssue[],
): CouponValidationErrorBody<C> {
  return validationErrorBody(code, issues);
}

/** 400 の応答 (code を引数で渡す) */
export function couponValidationErrorResponse<C extends CouponValidationErrorCode>(
  code: C,
  issues: readonly z.core.$ZodIssue[],
): NextResponse<CouponValidationErrorBody<C>> {
  return validationErrorResponse(code, issues);
}

/** 400 OP_INVALID_INPUT の本文 */
export function couponInvalidInputBody(issues: readonly z.core.$ZodIssue[]): CouponInvalidInputBody {
  return invalidInputBody(issues);
}

/** 400 OP_INVALID_INPUT の応答 */
export function couponInvalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<CouponInvalidInputBody> {
  return invalidInputResponse(issues);
}

/** 400 OP_INVALID_QUERY の本文 */
export function couponInvalidQueryBody(issues: readonly z.core.$ZodIssue[]): CouponInvalidQueryBody {
  return invalidQueryBody(issues);
}

/** 400 OP_INVALID_QUERY の応答 */
export function couponInvalidQueryResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<CouponInvalidQueryBody> {
  return invalidQueryResponse(issues);
}
