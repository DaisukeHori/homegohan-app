/**
 * POST /api/admin/catalog/import — カタログ手動インポート trigger
 * 権限: admin, super_admin
 *
 * sourceCode を受け取り、対応する Supabase Edge Function を呼び出す。
 * Edge Function が未デプロイの場合は 500 を返す (E2E J-43 許容)。
 *
 * E2E: w5-12-admin-adversarial J-41, J-41b, J-42, J-42b, J-42c, J-43
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { z } from 'zod';
import { getSupabaseServiceConfig, isMissingEnvError } from '@/lib/env-required';

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

export async function POST(request: Request) {
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
      { error: 'invalid_json', message: 'リクエストボディが不正です' },
      { status: 400 },
    );
  }

  const parseResult = ImportBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'invalid_source', message: 'sourceCode が不正です', details: parseResult.error.flatten() },
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
      { error: 'INTERNAL_ERROR', message: 'サーバー設定エラー' },
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
        { error: 'EDGE_FUNCTION_ERROR', message: `Edge Function がエラーを返しました (${edgeResponse.status})` },
        { status: 500 },
      );
    }

    const edgeData = await edgeResponse.json().catch(() => ({}));

    // 監査ログ (Edge Function 呼び出し成功後)
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    await supabase.from('admin_audit_logs').insert({
      actor_id: actor.id,
      action_type: 'admin.catalog.import',
      target_type: 'catalog',
      details: { sourceCode, function_name: functionName },
      severity: 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });

    return NextResponse.json({ ok: true, sourceCode, result: edgeData });
  } catch (err) {
    console.error('[api/admin/catalog/import] fetch error:', err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Edge Function 呼び出しに失敗しました' },
      { status: 500 },
    );
  }
}
