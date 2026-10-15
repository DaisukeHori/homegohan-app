// ハンズオンツアー Step 1 の保存 (POST /api/meal-plans/add-from-photo) が失敗したときの読み方 (モバイル。#1625)
// Canonical: docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.7 / §3.10
//
// 保存は getApi() (@homegohan/core の createHttpClient) で送る。失敗は例外で返ってくる:
//   - サーバーから応答を受け取れなかった (圏外・待ち時間切れ): HttpNetworkError
//   - 失敗の応答 (4xx / 5xx): `HTTP <状態> <statusText>: <本文>` の Error
//     (429 AI_DAILY_LIMIT・503 のメンテナンス中などは、src/lib/api.ts が固定の文の例外に置き換える。状態は読めない)
// Web (src/app/handson-tour/photo/page.tsx) は fetch の応答を直接読むが、判定は同じにする:
//   - 本文が sandbox_not_eligible (この利用者はお試しの保存の対象ではない) なら、失敗にせず Step 2 へ進める
//   - それ以外は失敗。エラー画面 (§3.10) を出し、handson_tour_step_error に記録する

import { isHttpNetworkError } from '@homegohan/core';
import { isSandboxNotEligibleBody } from '@homegohan/handson-tour-shared';

/** 保存の失敗の記録 (handson_tour_step_error の error_code / error_message / http_status。Web と同じ値) */
export type TourPhotoSaveFailure = {
  error_code: 'sandbox_save_failed' | 'sandbox_save_network_error';
  error_message: string;
  http_status?: number;
};

/** 保存の例外の読み方: 対象外 (Step 2 へ進める) か、失敗 (エラー画面) か */
export type TourPhotoSaveErrorOutcome =
  | { kind: 'not_eligible' }
  | { kind: 'failed'; failure: TourPhotoSaveFailure };

const SAVE_FAILED_MESSAGE = 'POST /api/meal-plans/add-from-photo failed';
const SAVE_THREW_MESSAGE = 'POST /api/meal-plans/add-from-photo threw';

// "HTTP 409 Conflict: {...}" / HTTP/2 で statusText が空の "HTTP 409 : {...}" (src/lib/api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]*)$/;

/** 失敗の応答の状態と本文 (JSON として読めなければ null)。HTTP の失敗の形でなければ null */
function httpFailureOf(error: unknown): { status: number; body: unknown } | null {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return null;
  const match = HTTP_ERROR_PATTERN.exec(message);
  if (!match) return null;
  let body: unknown = null;
  try {
    body = JSON.parse(match[2]);
  } catch {
    // 本文が JSON ではない (ゲートウェイの HTML など): 対象外の判定には使えない
  }
  return { status: Number(match[1]), body };
}

/**
 * 保存で投げられた例外を読む。
 * @param error getApi().post が投げた例外
 */
export function tourPhotoSaveErrorOutcomeOf(error: unknown): TourPhotoSaveErrorOutcome {
  if (isHttpNetworkError(error)) {
    return { kind: 'failed', failure: { error_code: 'sandbox_save_network_error', error_message: SAVE_THREW_MESSAGE } };
  }
  const http = httpFailureOf(error);
  if (http && isSandboxNotEligibleBody(http.body)) return { kind: 'not_eligible' };
  return {
    kind: 'failed',
    failure: http
      ? { error_code: 'sandbox_save_failed', error_message: SAVE_FAILED_MESSAGE, http_status: http.status }
      : { error_code: 'sandbox_save_failed', error_message: SAVE_FAILED_MESSAGE },
  };
}
