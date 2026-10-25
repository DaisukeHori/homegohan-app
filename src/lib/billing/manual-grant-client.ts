// 運営の画面の節 (client component) の通信の facade (billing/02 §8.4)。
// React に依存しない。fetch を 1 回呼び、結果を判別共用体で返す (例外を投げない。src/lib/auth/mfa/client.ts と同じ考え方)。
// ⚠️ client component が import するので、このファイルと import 先 (manual-grant.ts → core.ts / calendar-date-schema.ts) はサーバー専用のもの
// (next/headers・@/lib/supabase/server・@/lib/auth/helpers) を import しない。
import { z } from 'zod';
import {
  ManualPlanGrantResponseSchema,
  ManualPlanRevokeResponseSchema,
  ManualPlanViewResponseSchema,
  manualPlanPath,
  type ManualPlanGrantBody,
  type ManualPlanGrantResult,
  type ManualPlanRevokeBody,
  type ManualPlanRevokeResult,
  type ManualPlanView,
} from '@/lib/billing/manual-grant';

/** HTTP の応答として扱えなかった (fetch が例外を投げた・2xx なのに本文が形に合わない) ときの status。HTTP のステータスに 0 は無い */
export const MANUAL_GRANT_CLIENT_NO_STATUS = 0;
/** 本文から code を読めないときの code (manualGrantErrorMessage は既定の文を返す) */
export const MANUAL_GRANT_CLIENT_UNKNOWN_CODE = 'UNKNOWN';
/** JSON の本文を送るときのヘッダ */
export const MANUAL_GRANT_JSON_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/json' };

export interface ManualGrantClientSuccess<T> {
  readonly ok: true;
  readonly data: T;
}
export interface ManualGrantClientFailure {
  readonly ok: false;
  /** HTTP のステータス。応答として扱えなかったときは MANUAL_GRANT_CLIENT_NO_STATUS */
  readonly status: number;
  /** 本文の error.code (nested) か code (flat)。読めなければ MANUAL_GRANT_CLIENT_UNKNOWN_CODE。画面は manualGrantErrorMessage(code) で文を引く */
  readonly code: string;
}
export type ManualGrantClientResult<T> = ManualGrantClientSuccess<T> | ManualGrantClientFailure;

/**
 * 運営 API の失敗の本文 (nested。手動付与の route の rejectNullCharacterBody の 400 も { shape: 'nested' } で nested) と、flat の本文 ({ error, code }) の両方から code だけを読む。
 * 本文の文面 (error.message) は読まない (src/lib/auth/mfa/client.ts:87-96 と同じ。tests/lib-raw-error-message-scan.test.ts が
 * src/lib の結果に「エラーらしい名前の .message」を入れることを違反に数える。F27)
 */
const NestedErrorBodySchema = z.object({ error: z.object({ code: z.string().min(1) }) });
const FlatErrorBodySchema = z.object({ code: z.string().min(1) });

function failureCodeOf(body: unknown): string {
  const nested = NestedErrorBodySchema.safeParse(body);
  if (nested.success) return nested.data.error.code;
  const flat = FlatErrorBodySchema.safeParse(body);
  return flat.success ? flat.data.code : MANUAL_GRANT_CLIENT_UNKNOWN_CODE;
}

function failureOf(status: number, body: unknown): ManualGrantClientFailure {
  return { ok: false, status, code: failureCodeOf(body) };
}

const NO_RESPONSE_FAILURE: ManualGrantClientFailure = {
  ok: false,
  status: MANUAL_GRANT_CLIENT_NO_STATUS,
  code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
};

/** API を 1 回呼び、2xx の本文を schema で読む。Cookie のセッションで呼ぶ (same-origin)。応答は運営だけのものなので no-store */
export async function requestManualPlanApi<T>(
  path: string,
  init: Pick<RequestInit, 'method' | 'headers' | 'body'>,
  schema: z.ZodType<T>,
): Promise<ManualGrantClientResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return NO_RESPONSE_FAILURE;
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) return failureOf(response.status, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NO_RESPONSE_FAILURE;
  return { ok: true, data: parsed.data };
}

/** GET /api/super-admin/users/{id}/manual-plan */
export async function fetchManualPlanView(userId: string): Promise<ManualGrantClientResult<ManualPlanView>> {
  const result = await requestManualPlanApi(manualPlanPath(userId), { method: 'GET' }, ManualPlanViewResponseSchema);
  return result.ok ? { ok: true, data: result.data.data } : result;
}

/** POST /api/super-admin/users/{id}/manual-plan */
export async function grantManualPlanRequest(userId: string, body: ManualPlanGrantBody): Promise<ManualGrantClientResult<ManualPlanGrantResult>> {
  const result = await requestManualPlanApi(
    manualPlanPath(userId),
    { method: 'POST', headers: MANUAL_GRANT_JSON_HEADERS, body: JSON.stringify(body) },
    ManualPlanGrantResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.data } : result;
}

/** DELETE /api/super-admin/users/{id}/manual-plan */
export async function revokeManualPlanRequest(userId: string, body: ManualPlanRevokeBody): Promise<ManualGrantClientResult<ManualPlanRevokeResult>> {
  const result = await requestManualPlanApi(
    manualPlanPath(userId),
    { method: 'DELETE', headers: MANUAL_GRANT_JSON_HEADERS, body: JSON.stringify(body) },
    ManualPlanRevokeResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.data } : result;
}
