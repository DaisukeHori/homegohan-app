/**
 * GET /api/org/settings — 組織設定取得
 * PUT /api/org/settings — 組織設定更新
 * 権限: 所属組織の org_role が owner / admin (自組織のみ、#1235)。判定は共通の requireOrgAdmin() (#1161)
 *
 * E2E: w5-13-new-features-adversarial A-1, A-4, A-7
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const OrgSettingsUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  plan: z.enum(['standard', 'premium', 'enterprise']).optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: '更新するフィールドを少なくとも1つ指定してください',
});

/**
 * 500 の本文は汎用メッセージだけにする (#1172: 生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(method: string, message: string, err: unknown) {
  createLogger(`${method} /api/org/settings`, generateRequestId()).error(message, err);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    { status: 500 },
  );
}

function handleError(method: string, err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: err.message } },
      { status: 401 },
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: err.message } },
      { status: 403 },
    );
  }
  return internalError(method, '組織設定の処理に失敗しました', err);
}

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();

    const supabase = await createClient();
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, plan, created_at, updated_at')
      .eq('id', profile.organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '組織が見つかりません' } },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    return handleError('GET', err);
  }
}

export async function PUT(request: Request) {
  try {
    const { profile } = await requireOrgAdmin();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
        { status: 400 },
      );
    }

    const parseResult = OrgSettingsUpdateSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const updates = parseResult.data;

    const supabase = await createClient();
    const { data: org, error: updateError } = await supabase
      .from('organizations')
      .update({ ...updates, updated_at: new Date().toISOString() } as Record<string, unknown>)
      .eq('id', profile.organization_id)
      .select('id, name, plan, created_at, updated_at')
      .single();

    if (updateError || !org) {
      createLogger('PUT /api/org/settings', generateRequestId()).error(
        '組織設定の更新に失敗しました',
        updateError ?? new Error('organizations の更新結果が空です'),
      );
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: '設定の更新に失敗しました' } },
        { status: 500 },
      );
    }

    return NextResponse.json({ data: org });
  } catch (err) {
    return handleError('PUT', err);
  }
}
