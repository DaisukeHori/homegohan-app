/**
 * POST /api/super-admin/embeddings/regenerate — Embedding 再生成
 * super_admin ロール必須
 *
 * #1041 (F4-12) 修正:
 *  - 従来は `table` のバリデーション通過後、実処理を一切行わず常に
 *    `{ ok: true, message: '再生成ジョブをキューに追加しました' }` を返す偽成功だった。
 *  - ALLOWED_TABLES に実際には embedding 列を持たない `recipes` / `meals` /
 *    `catalog_products` が含まれており、実装済みの Edge Function
 *    (`supabase/functions/regenerate-embeddings`) が対応する
 *    `dataset_ingredients` / `dataset_recipes` / `dataset_menu_sets` と
 *    一致していなかった。ALLOWED_TABLES を実スキーマ (embedding 列を実際に
 *    持つテーブル) に合わせて修正する。
 *  - Edge Function 未設定 (env 不足) の場合は 503 を返す (安全側の失敗)。
 *  - Edge Function 呼び出しが失敗した場合は 502 を返す (偽成功にしない)。
 *    #1172: 502 の本文は固定の文 + HTTP ステータスだけ。Edge Function が返した error の文は構造化ログにだけ残す。
 *  - 成功時は Edge Function の実際の処理結果 (processed / hasMore 等) を
 *    そのまま返す。
 *
 * #1571: 再生成は運営の操作で DB (embedding 列) を書き換えるので、Edge Function が成功を返したときに
 * super_admin.embeddings.regenerate を監査ログに 1 行残す (対象のテーブル・条件・処理件数)。
 * 記録に失敗しても応答は変えない (失敗は db-logger に残る)。400 / 503 / 502 のときは記録しない
 * (502 は Edge Function が失敗を返したとき。途中まで書いたかは Edge Function の応答から分からない。構造化ログに残る)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { getSupabaseServiceConfig, isMissingEnvError } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { authFailureNested } from '@/lib/api/error-responses';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { createClient } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';

/** 構造化ログ (app_logs) の function_name */
const ROUTE_NAME = 'POST /api/super-admin/embeddings/regenerate';

// supabase/functions/regenerate-embeddings/index.ts の TABLE_CONFIGS と一致させる。
// (embedding 列を実際に持つテーブルのみ。dataset_menu_sets は content_embedding、
//  他は name_embedding を持つ。'recipes' / 'meals' / 'catalog_products' は
//  embedding 列を持たないため対象外 — 追加するには migration が必要)
const ALLOWED_TABLES = ['dataset_ingredients', 'dataset_recipes', 'dataset_menu_sets'] as const;
/** 400 の文: table が ALLOWED_TABLES に無い。受け付ける値 (英字の表の名前) は括弧に入れて添える (#1917 の続き。healthEnumMessage と同じ形) */
const TABLE_INVALID_MESSAGE = `対象の表 (table) は次のいずれかを指定してください (${ALLOWED_TABLES.join(' / ')})`;

interface EdgeFunctionResult {
  success?: boolean;
  processed?: number;
  offset?: number;
  nextOffset?: number;
  totalCount?: number | null;
  hasMore?: boolean;
  /** 英語の文。本文には入れない (regenerateResultMessage) */
  message?: string;
  error?: string;
}

/**
 * 成功の本文の message (#1917)。Edge Function の message は英語の文 ('Processed 42 rows. Call again with offset=42' など) なので
 * 本文に入れず、処理した件数と続きの有無から日本語の文を作る (Edge Function の文は使わない。次に送る英字の項目名 (offset) は括弧に入れる。#1917 の続き)
 */
function regenerateResultMessage(processed: number, hasMore: boolean, nextOffset: number | undefined): string {
  if (!hasMore) return `${processed} 件を再生成しました。残りはありません`;
  return nextOffset === undefined
    ? `${processed} 件を再生成しました。続きがあります`
    : `${processed} 件を再生成しました。続きは開始の位置 (offset) を ${nextOffset} にして実行してください`;
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const actor = await requireRole(['super_admin']);
    // 監査ログ (#1571) は本人の権限の client で書く。Edge Function を呼ぶ前に作る (作れずに失敗するなら、DB を書き換える前に止まる)
    const supabase = await createClient();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です' } }, { status: 400 });
    }

    const { table, onlyMissing, offset, limit } = (body as Record<string, unknown>) ?? {};

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: '対象の表 (table) は必須です' } }, { status: 400 });
    }

    if (!(ALLOWED_TABLES as readonly string[]).includes(table)) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: TABLE_INVALID_MESSAGE } },
        { status: 400 },
      );
    }

    // 接続情報は env-required の getter で取り出す (#1434。空白だけの値も欠けているとみなす。
    // 欠けている変数名は getter がサーバーのログに残す)
    let service: { url: string; serviceRoleKey: string };
    try {
      service = getSupabaseServiceConfig();
    } catch (envErr) {
      if (!isMissingEnvError(envErr)) throw envErr;
      // 判定不能 (Edge Function 呼び出し不可) な場合は成功を偽装せず、
      // 明示的にサービス利用不可を返す (fail-closed)。
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_UNAVAILABLE',
            message: '埋め込み再生成サービスが設定されていません (Supabase 接続情報が不足しています)',
          },
        },
        { status: 503 },
      );
    }

    const edgeFnUrl = `${service.url}/functions/v1/regenerate-embeddings`;

    let edgeRes: Response;
    try {
      edgeRes = await fetch(edgeFnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${service.serviceRoleKey}`,
        },
        body: JSON.stringify({
          table,
          onlyMissing: Boolean(onlyMissing),
          offset: typeof offset === 'number' ? offset : 0,
          limit: typeof limit === 'number' ? limit : 100,
        }),
      });
    } catch (fetchErr) {
      createLogger(ROUTE_NAME, generateRequestId())
        .withUser(actor.id)
        .error('埋め込み再生成の Edge Function を呼び出せませんでした', fetchErr, { table });
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_FAILED',
            message: '埋め込み再生成ジョブの呼び出しに失敗しました',
          },
        },
        { status: 502 },
      );
    }

    const edgeData = (await edgeRes.json().catch(() => ({}))) as EdgeFunctionResult;

    if (!edgeRes.ok || edgeData.error) {
      // #1172: Edge Function の error は、DB の取得エラーを包んだ生の文 (`Fetch error: <PostgREST のエラー文>`) のことがある
      // (supabase/functions/regenerate-embeddings/index.ts)。構造化ログにだけ残し、本文は固定の文 + HTTP ステータスにする
      createLogger(ROUTE_NAME, generateRequestId())
        .withUser(actor.id)
        .error('埋め込み再生成の Edge Function が失敗を返しました', new Error(edgeData.error ?? `HTTP ${edgeRes.status}`), {
          table,
          edge_status: edgeRes.status,
        });
      return NextResponse.json(
        {
          error: {
            code: 'OP_EMBEDDING_JOB_FAILED',
            message: `埋め込み再生成ジョブが失敗しました (HTTP ${edgeRes.status})`,
          },
        },
        { status: 502 },
      );
    }

    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'super_admin.embeddings.regenerate',
      targetType: 'embedding_table',
      details: {
        table,
        only_missing: Boolean(onlyMissing),
        offset: edgeData.offset ?? 0,
        processed: edgeData.processed ?? 0,
        has_more: edgeData.hasMore ?? false,
      },
      request,
      routeName: ROUTE_NAME,
    });

    return NextResponse.json({
      ok: true,
      table,
      onlyMissing: Boolean(onlyMissing),
      processed: edgeData.processed ?? 0,
      offset: edgeData.offset ?? 0,
      nextOffset: edgeData.nextOffset,
      totalCount: edgeData.totalCount ?? null,
      hasMore: edgeData.hasMore ?? false,
      message: regenerateResultMessage(edgeData.processed ?? 0, edgeData.hasMore ?? false, edgeData.nextOffset),
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}
