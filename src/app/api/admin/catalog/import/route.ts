/**
 * POST /api/admin/catalog/import — カタログ手動インポート trigger
 * 権限: admin, super_admin
 *
 * sourceCode を受け取り、対応する Supabase Edge Function を呼び出す。
 * Edge Function が未デプロイの場合は 500 を返す (E2E J-43 許容)。
 *
 * E2E: w5-12-admin-adversarial J-41, J-41b, J-42, J-42b, J-42c, J-43
 *
 * 失敗の本文は nested の形 { error: { code, message } } (同じ route の 401 / 403 と同じ形)。
 * code は従来の値 (invalid_json / invalid_source / INTERNAL_ERROR / EDGE_FUNCTION_ERROR) のまま、message は日本語の固定の文 (#1917)。
 * 以前は { error: '<code>', message: '<文>' } の形で、error に英字の code が入っていた
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { API_INVALID_JSON_MESSAGE } from '@/lib/api/error-responses';
import { z } from 'zod';
import { getSupabaseServiceConfig, isMissingEnvError } from '@/lib/env-required';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

export const dynamic = 'force-dynamic';

const VALID_SOURCE_CODES = [
  'seven_eleven_jp',
  'lawson_jp',
  'familymart_jp',
  'ministop_jp',
  'natural_lawson_jp',
] as const;

type SourceCode = typeof VALID_SOURCE_CODES[number];

const SOURCE_CODE_TO_FUNCTION: Record<SourceCode, string> = {
  seven_eleven_jp: 'import-seven-eleven-catalog',
  lawson_jp: 'import-lawson-catalog',
  familymart_jp: 'import-familymart-catalog',
  ministop_jp: 'import-ministop-catalog',
  natural_lawson_jp: 'import-natural-lawson-catalog',
};

const ImportBodySchema = z.object({
  sourceCode: z.enum(VALID_SOURCE_CODES),
});

/**
 * Edge Function (supabase/functions/_shared/catalog/import-runner.ts) の成功の応答のうち、本文に返してよい部分 (#1172)。
 * 成功 (200) の応答でも stats.productErrors[].error には商品ごとの失敗の文が入り、DB の upsert の失敗なら
 * PostgREST の生のエラー文 (テーブル名・列名・制約名) になる。本文には件数だけを返し、
 * 失敗の中身は catalog_import_runs.error_log と Edge Function のログで見る。
 */
const EdgeImportResultSchema = z.object({
  importRunId: z.string().nullable().optional(),
  dryRun: z.boolean().optional(),
  categoryCode: z.string().nullable().optional(),
  stats: z
    .object({
      pagesTotal: z.number().optional(),
      productsSeen: z.number().optional(),
      productsInserted: z.number().optional(),
      productsUpdated: z.number().optional(),
      productsUnchanged: z.number().optional(),
      productsDiscontinued: z.number().optional(),
      productErrors: z.array(z.unknown()).optional(),
    })
    .optional(),
});

interface CatalogImportSummary {
  importRunId: string | null;
  dryRun: boolean;
  categoryCode: string | null;
  stats: {
    pagesTotal?: number;
    productsSeen?: number;
    productsInserted?: number;
    productsUpdated?: number;
    productsUnchanged?: number;
    productsDiscontinued?: number;
    /** 失敗した商品の数 (失敗の文そのものは返さない) */
    productErrorCount: number;
  };
}

function summarizeImportResult(edgeData: unknown): CatalogImportSummary {
  const parsed = EdgeImportResultSchema.safeParse(edgeData);
  const data = parsed.success ? parsed.data : {};
  const { productErrors, ...counts } = data.stats ?? {};
  return {
    importRunId: data.importRunId ?? null,
    dryRun: data.dryRun ?? false,
    categoryCode: data.categoryCode ?? null,
    stats: { ...counts, productErrorCount: productErrors?.length ?? 0 },
  };
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_json', message: API_INVALID_JSON_MESSAGE } },
      { status: 400 },
    );
  }

  const parseResult = ImportBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'invalid_source', message: 'sourceCode が不正です' }, details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  const { sourceCode } = parseResult.data;
  const functionName = SOURCE_CODE_TO_FUNCTION[sourceCode];

  // 接続情報は env-required の getter で取り出す (#1434。空白だけの値も欠けているとみなす)。
  // 欠けている変数名は getter がサーバーのログに残すので、本文には固定の文だけを返す
  let service: { url: string; serviceRoleKey: string };
  try {
    service = getSupabaseServiceConfig();
  } catch (err) {
    if (!isMissingEnvError(err)) throw err;
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'サーバー設定エラー' } },
      { status: 500 },
    );
  }

  const edgeFunctionUrl = `${service.url}/functions/v1/${functionName}`;

  try {
    const edgeResponse = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${service.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourceCode }),
    });

    if (!edgeResponse.ok) {
      const errorText = await edgeResponse.text().catch(() => 'unknown');
      console.error(`[api/admin/catalog/import] Edge Function error (${edgeResponse.status}): ${errorText}`);
      return NextResponse.json(
        { error: { code: 'EDGE_FUNCTION_ERROR', message: `Edge Function がエラーを返しました (${edgeResponse.status})` } },
        { status: 500 },
      );
    }

    const edgeData: unknown = await edgeResponse.json().catch(() => ({}));

    // 監査ログ (Edge Function 呼び出し成功後)
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.catalog.import',
      targetType: 'catalog',
      details: { sourceCode, function_name: functionName },
      severity: 'info',
      request,
      routeName: 'api/admin/catalog/import POST',
    });

    // 商品ごとの失敗の文 (DB の生のエラー文を含みうる) は返さず、件数にまとめる (#1172)
    return NextResponse.json({ ok: true, sourceCode, result: summarizeImportResult(edgeData) });
  } catch (err) {
    console.error('[api/admin/catalog/import] fetch error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Edge Function 呼び出しに失敗しました' } },
      { status: 500 },
    );
  }
}
