/**
 * エラー境界 (error.tsx / global-error.tsx) が受け取った例外を記録する (#1207)
 *
 * 画面の描画中に起きた例外は、ここでコンソールとサーバーログ (app_logs) に残す。
 * サーバーログへの送信は既存の logToServer (src/lib/db-logger.ts → POST /api/log) を使う。
 * /api/log は未ログインの要求を 401 で断る設計なので、ログイン前の画面で起きた例外は
 * サーバーログには残らない (コンソールと、Vercel の関数ログにある digest で追う)。
 *
 * 守ること:
 *  - 記録に URL / パスを含めない。招待 (/invite/{token}) や家族参加の承認 (/family/promotions/{token}) の
 *    token のように、URL に秘密が入るページがあるため。どの境界で起きたかは boundary (例: 'org') で分かる。
 *  - 例外の文面は長さを切り詰める (秘密情報のマスクと最終的な切り詰めはサーバー側の sanitizeLogEntry が行う)。
 *  - 記録の失敗で画面を壊さない。この関数は例外を投げない。
 *  - 利用者に見せるのは digest (サーバー側のログと突き合わせる短い ID) だけ。例外の文面は見せない。
 */

import { logToServer } from '@/lib/db-logger';

const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 1500;

/** Next.js が付ける digest は数字や英数字の短い ID。それ以外の値は画面に出さない */
const SAFE_ERROR_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 画面に出してよい「エラーコード」を返す。digest が短い英数字の ID のときだけその値、それ以外は undefined。
 * (例外オブジェクトに任意の文字列が載っていても、そのまま画面には出さない)
 */
export function toDisplayErrorCode(digest: unknown): string | undefined {
  return typeof digest === 'string' && SAFE_ERROR_CODE.test(digest) ? digest : undefined;
}

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 境界が捕まえた例外を記録する。
 * @param boundary どの境界で起きたか (例: 'root' / 'org' / 'admin')。URL の代わりに使う
 */
export function reportBoundaryError(boundary: string, error: unknown): void {
  try {
    console.error(`[ErrorBoundary:${boundary}]`, error);

    const err = error as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown } | null | undefined;
    const isObject = typeof err === 'object' && err !== null;

    // logToServer は失敗しても例外を投げない (fetch の失敗は握りつぶす) が、差し替えられても画面を壊さないよう二重に守る
    void Promise.resolve(
      logToServer('error', `error boundary caught: ${boundary}`, {
        boundary,
        name: isObject ? clamp(err.name, 100) : undefined,
        message: clamp(isObject ? err.message : String(error), MAX_MESSAGE_CHARS),
        digest: isObject ? toDisplayErrorCode(err.digest) : undefined,
        stack: isObject ? clamp(err.stack, MAX_STACK_CHARS) : undefined,
      }),
    ).catch(() => {});
  } catch {
    // 記録の失敗で画面を壊さない
  }
}
