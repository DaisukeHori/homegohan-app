/**
 * GET /api/org/settings — 組織設定取得
 * PUT /api/org/settings — 組織設定更新
 * 権限: 所属組織の org_role が owner / admin (自組織のみ、#1235)。判定は共通の requireOrgAdmin() (#1161)
 * 受け取るキー・返す列は src/lib/org-settings-api.ts (組織の設定の画面が送るキーを全部受け取る。#1735)
 * プラン (plan) は返すが受け取らない: 本文に plan があれば 400 VALIDATION_ERROR (変えるのは運営の PATCH /api/admin/organizations/{id} だけ。#1912)
 *
 * E2E: w5-13-new-features-adversarial A-1, A-4, A-7
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ORG_API_INTERNAL_ERROR_MESSAGE, orgAuthFailureNested } from '@/lib/org-api-errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import {
  ORG_SETTINGS_SELECT_COLUMNS,
  OrgSettingsUpdateSchema,
  toOrgSettingsUpdateRow,
} from '@/lib/org-settings-api';

export const dynamic = 'force-dynamic';

/**
 * 500 の本文は汎用メッセージだけにする (#1172: 生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(method: string, message: string, err: unknown) {
  createLogger(`${method} /api/org/settings`, generateRequestId()).error(message, err);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: ORG_API_INTERNAL_ERROR_MESSAGE } },
    { status: 500 },
  );
}

/**
 * 401 / 403 は日本語の固定の文で返す (src/lib/org-api-errors.ts)。code は従来どおり UNAUTHORIZED / FORBIDDEN。
 * 例外の文面 (err.message。'AUTH_UNAUTHENTICATED'・'owner/admin role required' など) は本文に入れない
 * (組織の設定の画面は本文の error.message をそのまま見せるため、英語が出ていた)。
 * それ以外は 500 の汎用メッセージ
 */
function handleError(method: string, err: unknown) {
  const authFailure = orgAuthFailureNested(err);
  if (authFailure) {
    return authFailure;
  }
  return internalError(method, '組織設定の処理に失敗しました', err);
}

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();

    const supabase = await createClient();
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select(ORG_SETTINGS_SELECT_COLUMNS)
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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
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

    const updates = toOrgSettingsUpdateRow(parseResult.data);

    const supabase = await createClient();
    const { data: org, error: updateError } = await supabase
      .from('organizations')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', profile.organization_id)
      .select(ORG_SETTINGS_SELECT_COLUMNS)
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
