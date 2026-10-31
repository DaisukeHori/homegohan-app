/**
 * 運営ロールの MFA の画面 (/settings/security/mfa/*) の通信の facade (#1176。docs/design/cross/12-operator-mfa.md §15.1)
 *
 * React に依存しない。fetch を 1 回呼び、結果を判別共用体 MfaClientResult<T> で返す (例外を投げない。
 * src/lib/account-self-service.ts の AccountExportResult と同じ考え方)。画面は result.ok で分け、失敗は status と code で分ける (§15.2)。
 * 2xx の本文は §14 の応答の Zod で読み、形が違えば失敗 (MFA_CLIENT_NO_STATUS) として扱う。
 * 失敗の本文は自己サービス (§14.1〜14.6) の flat の { error, code } と、reset (§14.7) の nested の { error: { code, message } } の
 * 両方から code だけを読む (文面は読まない。画面の文は mfaErrorMessage)。
 *
 * ⚠️ client component ("use client") が import するので、このファイルと import 先の src/lib/auth/mfa/schemas.ts は
 * サーバー専用のもの (next/headers・@/lib/supabase/server・node:crypto を持つ backup-codes.ts・@/lib/auth/helpers を持つ page-guard.ts) を import しない。
 *
 * 段 A は status / enroll / verify / recover の 4 つ。段 B で MFA_API_PATHS の backupCodes・factors と mfaFactorPath・
 * regenerateBackupCodes・unenrollMfaFactor を足した。段 C で superAdminAdmins と mfaResetPath・resetOperatorMfa を足した (§22.3)。
 * MFA_ERROR_MESSAGES は reset の code の行も段 A から持つ。
 */
import { z } from 'zod';
import { OPERATOR_ROLE_LABELS } from '@/lib/admin/operator-role-labels';
import {
  MfaBackupCodesResponseSchema,
  MfaEnrollResponseSchema,
  MfaRecoverResponseSchema,
  MfaResetResponseSchema,
  MfaStatusResponseSchema,
  MfaUnenrollResponseSchema,
  MfaVerifyResponseSchema,
  type MfaBackupCodesResponse,
  type MfaEnrollResponse,
  type MfaRecoverBody,
  type MfaRecoverResponse,
  type MfaResetBody,
  type MfaResetResponse,
  type MfaStatusResponse,
  type MfaUnenrollResponse,
  type MfaVerifyBody,
  type MfaVerifyResponse,
} from '@/lib/auth/mfa/schemas';

/** §14 の API のパス。画面はこれ以外の API の URL を組み立てない */
export const MFA_API_PATHS = {
  status: '/api/auth/mfa/status',
  enroll: '/api/auth/mfa/enroll',
  verify: '/api/auth/mfa/verify',
  recover: '/api/auth/mfa/recover',
  /** 段 B (§14.6) */
  backupCodes: '/api/auth/mfa/backup-codes',
  /** 段 B (§14.4)。DELETE の URL は mfaFactorPath(id) */
  factors: '/api/auth/mfa/factors',
  /** 段 C (§14.7)。POST の URL は mfaResetPath(userId) */
  superAdminAdmins: '/api/super-admin/admins',
} as const;

/** DELETE /api/auth/mfa/factors/{id} の URL (段 B) */
export function mfaFactorPath(factorId: string): string {
  return `${MFA_API_PATHS.factors}/${encodeURIComponent(factorId)}`;
}

/** POST /api/super-admin/admins/{id}/mfa/reset の URL (段 C) */
export function mfaResetPath(userId: string): string {
  return `${MFA_API_PATHS.superAdminAdmins}/${encodeURIComponent(userId)}/mfa/reset`;
}

/** HTTP の応答として扱えなかった (fetch が例外を投げた・2xx なのに本文が §14 の形でない) ときの status。HTTP のステータスに 0 は無い */
export const MFA_CLIENT_NO_STATUS = 0;
/** 本文から code を読めないときの code (mfaErrorMessage は既定の文を返す) */
export const MFA_CLIENT_UNKNOWN_CODE = 'UNKNOWN';
/** JSON の本文を送るときのヘッダ (verify / recover / reset) */
export const MFA_JSON_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/json' };

export interface MfaClientSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface MfaClientFailure {
  readonly ok: false;
  /** HTTP のステータス (401 / 403 / 404 / 409 / 429 / 500 など)。応答として扱えなかったときは MFA_CLIENT_NO_STATUS */
  readonly status: number;
  /** 本文の code (§14.8)。読めなければ MFA_CLIENT_UNKNOWN_CODE */
  readonly code: string;
  /** Retry-After ヘッダの秒 (429)。無い・正の有限の数でないときは null */
  readonly retryAfterSec: number | null;
}

/** client.ts の関数の戻り値 */
export type MfaClientResult<T> = MfaClientSuccess<T> | MfaClientFailure;

/** 自己サービス API の失敗の本文 (§14 冒頭の flat の形) */
const FlatErrorBodySchema = z.object({ code: z.string().min(1) });
/** reset の失敗の本文 (運営 API の nested の形 §14.8.2) */
const NestedErrorBodySchema = z.object({ error: z.object({ code: z.string().min(1) }) });

function failureCodeOf(body: unknown): string {
  const flat = FlatErrorBodySchema.safeParse(body);
  if (flat.success) return flat.data.code;
  const nested = NestedErrorBodySchema.safeParse(body);
  return nested.success ? nested.data.error.code : MFA_CLIENT_UNKNOWN_CODE;
}

function retryAfterSecOf(responseHeaders: Headers): number | null {
  const raw = responseHeaders.get('Retry-After');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

const NO_RESPONSE_FAILURE: MfaClientFailure = {
  ok: false,
  status: MFA_CLIENT_NO_STATUS,
  code: MFA_CLIENT_UNKNOWN_CODE,
  retryAfterSec: null,
};

/**
 * API を 1 回呼び、2xx の本文を schema で読む。例外は投げない (fetch の例外も、応答の読み取りの例外も NO_RESPONSE_FAILURE にする)。
 * Cookie のセッションで呼ぶので credentials は same-origin、応答は本人だけのものなので cache は no-store。
 */
export async function requestMfaApi<T>(
  path: string,
  init: Pick<RequestInit, 'method' | 'headers' | 'body'>,
  schema: z.ZodType<T>,
): Promise<MfaClientResult<T>> {
  try {
    const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
    /** JSON でない本文 (空・HTML のエラー画面) は null として読む */
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, data: parsed.data } : NO_RESPONSE_FAILURE;
    }
    return {
      ok: false,
      status: response.status,
      code: failureCodeOf(body),
      retryAfterSec: retryAfterSecOf(response.headers),
    };
  } catch {
    return NO_RESPONSE_FAILURE;
  }
}

/** 画面の文言 (§15 の表と同じ文)。Map にして、constructor などの Object の名前の code を拾わない */
export const MFA_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map<string, string>([
  ['AUTH_2FA_INVALID', '確認コードが正しくありません。認証アプリの最新のコードを入力してください。'],
  ['RATE_LIMITED', '試行回数が多すぎます。しばらくしてから再度お試しください。'],
  ['AUTH_2FA_NOT_ENROLLED', '認証アプリが登録されていません。先に登録してください。'],
  ['AUTH_2FA_ALREADY_ENROLLED', '認証アプリはすでに登録されています。変更するには先に解除してください。'],
  ['AUTH_2FA_REQUIRED', 'この操作には二段階認証の確認が必要です。'],
  ['PERM_DENIED', 'この画面は運営ロールの方だけが使えます。'],
  ['AUTH_UNAUTHENTICATED', 'ログインが切れました。もう一度ログインしてください。'],
  ['AUTH_2FA_NATIVE_SESSION', 'アプリの中では、この画面で二段階認証の確認や解除ができません。アプリの確認画面か、ブラウザで行ってください。'],
  ['UNAUTHORIZED', 'ログインが切れました。もう一度ログインしてください。'],
  ['FORBIDDEN', `この操作には${OPERATOR_ROLE_LABELS.super_admin}の権限と、二段階認証の確認が必要です。`],
  ['OP_SELF_MODIFY', '自分自身の二段階認証は、ここでは解除できません。バックアップコードか、二段階認証の設定の画面で解除してください。'],
  ['OP_INVALID_INPUT', '入力内容を確認してください (理由・本人確認の方法・確認のチェックが必要です)。'],
  ['NOT_FOUND', '対象の利用者が見つかりません。'],
]);

/** 表に無い code (MFA_CLIENT_UNKNOWN_CODE・INTERNAL_ERROR・VALIDATION_ERROR など) の文 */
export const MFA_FALLBACK_ERROR_MESSAGE = '処理中にエラーが発生しました。しばらくしてからお試しください。';

export function mfaErrorMessage(code: string): string {
  return MFA_ERROR_MESSAGES.get(code) ?? MFA_FALLBACK_ERROR_MESSAGE;
}

/**
 * 登録の verify が成功したのに backup_codes が無いとき (§14.3 のコードの発行の失敗・応答が届かず打ち直した 2 回目の verify) に、
 * setup の画面が BackupCodesPanel の代わりに出す文 (§15.2)。page.tsx は名前つきの export を持てないので、ここに置く
 */
export const MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE =
  '認証アプリの登録は完了しましたが、バックアップコードを表示できませんでした。認証アプリでの確認はこのまま使えます。二段階認証の設定の画面で、バックアップコードを発行し直してください (表示できなかったコードは、発行し直すと使えなくなります)。';

/** GET /api/auth/mfa/status (§14.1。段 A) */
export function getMfaStatus(): Promise<MfaClientResult<MfaStatusResponse>> {
  return requestMfaApi<MfaStatusResponse>(MFA_API_PATHS.status, { method: 'GET' }, MfaStatusResponseSchema);
}

/** POST /api/auth/mfa/enroll (§14.2。段 A)。本文なし */
export function startMfaEnrollment(): Promise<MfaClientResult<MfaEnrollResponse>> {
  return requestMfaApi<MfaEnrollResponse>(MFA_API_PATHS.enroll, { method: 'POST' }, MfaEnrollResponseSchema);
}

/** POST /api/auth/mfa/verify (§14.3。段 A) */
export function verifyMfaCode(body: MfaVerifyBody): Promise<MfaClientResult<MfaVerifyResponse>> {
  return requestMfaApi<MfaVerifyResponse>(
    MFA_API_PATHS.verify,
    { method: 'POST', headers: MFA_JSON_HEADERS, body: JSON.stringify(body) },
    MfaVerifyResponseSchema,
  );
}

/** POST /api/auth/mfa/recover (§14.5。段 A) */
export function recoverWithBackupCode(body: MfaRecoverBody): Promise<MfaClientResult<MfaRecoverResponse>> {
  return requestMfaApi<MfaRecoverResponse>(
    MFA_API_PATHS.recover,
    { method: 'POST', headers: MFA_JSON_HEADERS, body: JSON.stringify(body) },
    MfaRecoverResponseSchema,
  );
}

/** POST /api/auth/mfa/backup-codes (§14.6。段 B)。本文なし */
export function regenerateBackupCodes(): Promise<MfaClientResult<MfaBackupCodesResponse>> {
  return requestMfaApi<MfaBackupCodesResponse>(MFA_API_PATHS.backupCodes, { method: 'POST' }, MfaBackupCodesResponseSchema);
}

/** DELETE /api/auth/mfa/factors/{id} (§14.4。段 B)。本文なし */
export function unenrollMfaFactor(factorId: string): Promise<MfaClientResult<MfaUnenrollResponse>> {
  return requestMfaApi<MfaUnenrollResponse>(mfaFactorPath(factorId), { method: 'DELETE' }, MfaUnenrollResponseSchema);
}

/** POST /api/super-admin/admins/{id}/mfa/reset (§14.7。段 C。OperatorMfaResetSection が呼ぶ) */
export function resetOperatorMfa(userId: string, body: MfaResetBody): Promise<MfaClientResult<MfaResetResponse>> {
  return requestMfaApi<MfaResetResponse>(
    mfaResetPath(userId),
    { method: 'POST', headers: MFA_JSON_HEADERS, body: JSON.stringify(body) },
    MfaResetResponseSchema,
  );
}
