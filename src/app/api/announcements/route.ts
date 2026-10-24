import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { API_INTERNAL_ERROR_MESSAGE, API_INVALID_JSON_MESSAGE, authFailureFlat } from '@/lib/api/error-responses';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';

/** 監査ログ (admin_audit_logs) の action_type。docs/design/operator/07-audit-monitoring.md §4.1 */
const ANNOUNCEMENT_CREATE_AUDIT_ACTION = 'admin.announcement.create';
/** 監査ログの失敗を db-logger (app_logs.function_name) に出すときの名前 */
const POST_ROUTE_NAME = 'POST /api/announcements';

/** 400: title / content が空 */
const TITLE_AND_CONTENT_REQUIRED_MESSAGE = 'タイトルと本文を入力してください';
/** 400: isPublic が真偽値でない */
const IS_PUBLIC_INVALID_MESSAGE = '公開の設定が正しくありません';

/**
 * 認可エラー (401 / 403) は日本語の固定の文で返し (#1917)、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
function handleError(method: 'GET' | 'POST', error: unknown) {
  const authFailure = authFailureFlat(error);
  if (authFailure) return authFailure;
  createLogger(`${method} /api/announcements`, generateRequestId()).error('お知らせの処理に失敗しました', error);
  return NextResponse.json({ error: API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
}

// お知らせ一覧
//   mode=public : 一般公開用。認証不要 (公開済みのお知らせだけ)
//   それ以外    : 管理用。admin / super_admin のみ (共通の requireRole()、#1161)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode'); // 'admin' | 'public'

  try {
    // 管理用：権限チェック
    if (mode !== 'public') {
      await requireRole(['admin', 'super_admin']);
    }

    const supabase = await createClient();
    let query = supabase.from('announcements').select('*').order('created_at', { ascending: false });

    if (mode === 'public') {
      // 一般公開用
      query = query.eq('is_public', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ announcements: data });

  } catch (error) {
    return handleError('GET', error);
  }
}

// お知らせ作成 (admin / super_admin のみ。共通の requireRole()、#1161)
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    // 1. 権限チェック
    const actor = await requireRole(['admin', 'super_admin']);

    // 2. 作成
    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { title, content, isPublic } = (parsedBody.body ?? {}) as {
      title?: unknown;
      content?: unknown;
      isPublic?: unknown;
    };

    // title / content は NOT NULL 列。未入力のまま DB に渡すと制約違反が 500 になるため、先に 400 で返す
    if (typeof title !== 'string' || title.trim() === '' || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ error: TITLE_AND_CONTENT_REQUIRED_MESSAGE }, { status: 400 });
    }
    if (isPublic !== undefined && typeof isPublic !== 'boolean') {
      return NextResponse.json({ error: IS_PUBLIC_INVALID_MESSAGE }, { status: 400 });
    }

    const supabase = await createClient(); // 監査ログ (admin_audit_logs) は本人の権限で書く (RLS の audit_logs_insert_admins)
    const { data, error } = await getSupabaseAdmin() // お知らせの書き込みは service_role だけ (運営の直接の書き込みを塞いだ。20261024140000。#1917)
      .from('announcements')
      .insert({
        title,
        content,
        is_public: isPublic,
        created_by: actor.id,
        published_at: isPublic ? new Date().toISOString() : null
      })
      .select()
      .single();

    if (error) throw error;

    // 運営の変更系はすべて監査ログに残す (#1571)。作成できたときだけ 1 行。
    // 記録の失敗で作成の応答は変えない (fail-open。失敗は recordAdminAudit が db-logger に残す)。
    // タイトル・本文の中身は details に入れない (公開の状態だけ)
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: ANNOUNCEMENT_CREATE_AUDIT_ACTION,
      targetId: data.id,
      targetType: 'announcement',
      details: {
        announcement_id: data.id,
        is_public: data.is_public,
        published_at: data.published_at,
      },
      request,
      routeName: POST_ROUTE_NAME,
    });

    return NextResponse.json({ announcement: data });

  } catch (error) {
    return handleError('POST', error);
  }
}
