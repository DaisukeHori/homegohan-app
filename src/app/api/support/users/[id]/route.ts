import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { recordAdminAudit } from '@/lib/admin/audit';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isUuid } from '@/lib/http-params';
import { NextResponse } from 'next/server';

/**
 * 500 の本文は汎用メッセージだけにする (#1172: Supabase / Postgres の生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(err: unknown, metadata?: Record<string, unknown>) {
  createLogger('GET /api/support/users/[id]', generateRequestId()).error('サポート用ユーザー詳細の取得に失敗しました', err, metadata);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ユーザー詳細取得（サポート用 - 限定情報）
// 権限: support / admin / super_admin (共通の requireRole()、#1161)
// #1200: 情報を返すたびに admin_audit_logs へ admin.user.view_support を記録する
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const actor = await requireRole(['support', 'admin', 'super_admin']);

    // uuid 型の列に UUID でない文字列を渡すと 22P02 になり、存在しない id なのに 500 になる
    if (!isUuid(params.id)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 認可を通したあとだけ service_role で読む (認可の前に使うと権限昇格になる)。
    // user_profiles / planned_meals / ai_consultation_sessions は RLS で本人の行しか見えず、
    // セッションの client のままだとサポート担当が他ユーザーを開いても 0 行 (= 500) になる。
    const supabaseAdmin = getSupabaseAdmin();

    // ユーザー基本情報取得（プライバシー考慮で限定）
    const { data: targetUser, error: targetError } = await supabaseAdmin
      .from('user_profiles')
      .select(`
        id,
        nickname,
        age_group,
        gender,
        roles,
        organization_id,
        is_banned,
        banned_at,
        banned_reason,
        last_login_at,
        login_count,
        profile_completeness,
        created_at,
        updated_at
      `)
      .eq('id', params.id)
      .maybeSingle();

    if (targetError) {
      return internalError(new Error(targetError.message), {
        failed_queries: ['user_profiles (target)'],
        error_code: targetError.code,
      });
    }
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 最近のAIセッション数の起点
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [mealRes, aiSessionRes, inquiriesRes, notesRes] = await Promise.all([
      // 食事記録の概要統計 (対象ユーザーが完了した食事の数)。
      // planned_meals に user_id 列は無く、持ち主は daily_meal_id → user_daily_meals.user_id なので、
      // user_daily_meals!inner で対象ユーザーの行に絞る。絞らないと全ユーザー分を数えてしまう
      // (以前は RLS のおかげで「閲覧者本人」の分が返っていた。service_role では全員分になる)
      supabaseAdmin
        .from('planned_meals')
        .select('id, user_daily_meals!inner(user_id)', { count: 'exact', head: true })
        .eq('user_daily_meals.user_id', params.id)
        .eq('is_completed', true),
      // 最近のAIセッション数
      supabaseAdmin
        .from('ai_consultation_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', params.id)
        .gte('created_at', thirtyDaysAgo.toISOString()),
      // 問い合わせ履歴
      supabaseAdmin
        .from('inquiries')
        .select('id, inquiry_type, subject, status, created_at')
        .eq('user_id', params.id)
        .order('created_at', { ascending: false })
        .limit(10),
      // 管理者ノート取得
      supabaseAdmin
        .from('admin_user_notes')
        .select(`
          id,
          note,
          created_at,
          admin_id
        `)
        .eq('user_id', params.id)
        .order('created_at', { ascending: false }),
    ]);

    // 取得に失敗したまま続けると、0 件や空の一覧として黙って返してしまう。握りつぶさず 500 にする
    const failures = [
      { query: 'planned_meals (completed count)', error: mealRes.error },
      { query: 'ai_consultation_sessions (count)', error: aiSessionRes.error },
      { query: 'inquiries', error: inquiriesRes.error },
      { query: 'admin_user_notes', error: notesRes.error },
    ].filter((f) => f.error);
    if (failures.length > 0) {
      return internalError(new Error(failures[0].error!.message), {
        failed_queries: failures.map((f) => f.query),
        error_code: failures[0].error!.code,
      });
    }

    const body = {
      user: {
        id: targetUser.id,
        nickname: targetUser.nickname,
        ageGroup: targetUser.age_group,
        gender: targetUser.gender,
        roles: targetUser.roles,
        organizationId: targetUser.organization_id,
        isBanned: targetUser.is_banned,
        bannedAt: targetUser.banned_at,
        bannedReason: targetUser.banned_reason,
        lastLoginAt: targetUser.last_login_at,
        loginCount: targetUser.login_count,
        profileCompleteness: targetUser.profile_completeness,
        createdAt: targetUser.created_at,
        updatedAt: targetUser.updated_at,
      },
      stats: {
        mealCount: mealRes.count || 0,
        aiSessionCount: aiSessionRes.count || 0,
      },
      inquiries: inquiriesRes.data || [],
      notes: notesRes.data || [],
    };

    // #1200: 他ユーザーの情報を返す前に、誰が誰を閲覧したかを監査ログへ残す。
    // 404 (対象なし) は上で返しているため、ここに来るのは情報を返すときだけ。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details には返した項目名だけを入れ、値や問い合わせ・ノートの内容は入れない。
    // 監査ログの INSERT は RLS (actor_id = auth.uid() かつ運営ロール) を通すため、本人のセッションの client で行う。
    await recordAdminAudit({
      supabase: await createClient(),
      actorId: actor.id,
      actionType: 'admin.user.view_support',
      targetId: params.id,
      targetType: 'user',
      details: {
        viewed_fields: [
          ...Object.keys(body.user).map((field) => `user.${field}`),
          'stats',
          'inquiries',
          'notes',
        ],
      },
      request,
      routeName: 'api/support/users/[id] GET',
    });

    return NextResponse.json(body);

  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return internalError(error);
  }
}
