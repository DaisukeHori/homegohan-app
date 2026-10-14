/**
 * 運営画面の「未対応 (準備中)」機能に対する API の共通応答 (#1126 #1128 #1149)
 *
 * 実処理がまだ無い機能 (データの書き出し・AI コンテンツの審査・LLM 利用クォータの変更) の API は、
 * 成功したように見せかけず、501 + `OP_NOT_SUPPORTED` を返す。
 * 以前は、受け付けたふりをして保存しない (クォータ変更の監査ログだけ残る)、永久に処理中のまま
 * (エクスポート)、空の一覧を返す (AI コンテンツ) などで、運営者に「うまくいっている」と誤認させていた。
 *
 * 認可 (401 / 403) は通常どおり先に行う。権限のある人にだけ「未対応」と伝え、権限のない人には何も教えない。
 */
import { NextResponse } from 'next/server';
import { requireRole, type RoleName } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';

/** 未対応 (準備中) の機能を呼ばれたときのエラーコード。HTTP 501 */
export const OP_NOT_SUPPORTED = 'OP_NOT_SUPPORTED';

/** 501 + OP_NOT_SUPPORTED の応答を作る (認可は呼び出し側で済ませておくこと) */
export function notSupportedResponse(message: string) {
  return NextResponse.json({ error: { code: OP_NOT_SUPPORTED, message } }, { status: 501 });
}

/**
 * 認可 (requireRole) を通った人にだけ 501 を返す。
 *   - 未認証は 401、ロール不足は 403 (従来の運営 API と同じコード)
 *   - 想定外の例外は createLogger で記録し、本文は汎用メッセージだけにする (#1172)
 */
export async function respondNotSupported(options: {
  /** ログに残す route 名 (例: 'GET /api/super-admin/exports') */
  routeName: string;
  roles: ReadonlyArray<RoleName>;
  message: string;
}) {
  try {
    await requireRole(options.roles);
    return notSupportedResponse(options.message);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    createLogger(options.routeName, generateRequestId()).error('未対応 API の認可で予期しないエラー', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
