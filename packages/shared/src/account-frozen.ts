/**
 * アカウントの凍結 (BAN) で /api を止めたときの 403 の取り決め (#1030 / #1861)。
 *
 * サーバー (lib/supabase/middleware.ts の /api の分岐) は、凍結中の利用者の /api 呼び出しを、凍結中も呼べる API
 * (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS ほか) を除いて、次の本文の 403 で止める:
 *   403 { error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } }
 * モバイル (apps/mobile/src/lib/account-frozen.ts) は、この 403 を見分けて凍結の画面 (Web の /frozen を WebView で開く) へ移る。
 * サーバーとモバイルで同じ値を使うため、置き場はこのファイルの 1 つにする。
 * 文 (ACCOUNT_FROZEN_MESSAGE) は、Web の凍結の画面 (src/app/frozen/page.tsx) の見出しと同じ。
 *
 * Node / Deno / RN 固有の API は使わない。副作用は無い。
 */

/** 凍結で止めたときのエラーコード */
export const ACCOUNT_FROZEN_CODE = 'AUTH_ACCOUNT_FROZEN';

/** 凍結で止めたときの HTTP ステータス (403 Forbidden: 本人だが、凍結中のためこの操作は許さない) */
export const ACCOUNT_FROZEN_STATUS = 403;

/** 凍結で止めたときの本文の文 (#1172: 内部の詳細を出さない)。Web の凍結の画面の見出しと同じ */
export const ACCOUNT_FROZEN_MESSAGE = 'アカウントが凍結されています';

/** middleware が返す 403 の本文 (入れ子の形) */
export interface AccountFrozenBody {
  error: { code: typeof ACCOUNT_FROZEN_CODE; message: typeof ACCOUNT_FROZEN_MESSAGE };
}

export function accountFrozenBody(): AccountFrozenBody {
  return { error: { code: ACCOUNT_FROZEN_CODE, message: ACCOUNT_FROZEN_MESSAGE } };
}

/**
 * 本文の code を読む。middleware の入れ子 { error: { code } } と、route の平たい { error, code }
 * (本人向けの請求の API など。cross/15 の requireUserAllowingMissingProfile の ForbiddenError) の両方を受ける
 */
function codeOfBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (typeof code === 'string') return code;
  if (error && typeof error === 'object') {
    const nested = (error as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/** 応答の本文 (JSON を読んだもの) が「アカウントが凍結されています」(AUTH_ACCOUNT_FROZEN) か */
export function isAccountFrozenBody(body: unknown): boolean {
  return codeOfBody(body) === ACCOUNT_FROZEN_CODE;
}
