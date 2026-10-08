import { createClient } from '@/lib/supabase/server';
import { recordAdminAudit } from '@/lib/admin/audit';
import { NextResponse } from 'next/server';

// ユーザー詳細取得（サポート用 - 限定情報）
// #1200: 情報を返すたびに admin_audit_logs へ admin.user.view_support を記録する
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // サポート権限確認
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || !profile?.roles?.some((r: string) => ['admin', 'super_admin', 'support'].includes(r))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // ユーザー基本情報取得（プライバシー考慮で限定）
    const { data: targetUser, error } = await supabase
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
      .single();

    if (error) throw error;
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 食事記録の概要統計
    const { count: mealCount } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true })
      .eq('is_completed', true);

    // 最近のAIセッション数
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { count: aiSessionCount } = await supabase
      .from('ai_consultation_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', params.id)
      .gte('created_at', thirtyDaysAgo.toISOString());

    // 問い合わせ履歴
    const { data: inquiries } = await supabase
      .from('inquiries')
      .select('id, inquiry_type, subject, status, created_at')
      .eq('user_id', params.id)
      .order('created_at', { ascending: false })
      .limit(10);

    // 管理者ノート取得
    const { data: notes } = await supabase
      .from('admin_user_notes')
      .select(`
        id,
        note,
        created_at,
        admin_id
      `)
      .eq('user_id', params.id)
      .order('created_at', { ascending: false });

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
        mealCount: mealCount || 0,
        aiSessionCount: aiSessionCount || 0,
      },
      inquiries: inquiries || [],
      notes: notes || [],
    };

    // #1200: 他ユーザーの情報を返す前に、誰が誰を閲覧したかを監査ログへ残す。
    // 404 (対象なし) は上で返しているため、ここに来るのは情報を返すときだけ。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)。
    // details には返した項目名だけを入れ、値や問い合わせ・ノートの内容は入れない。
    await recordAdminAudit({
      supabase,
      actorId: user.id,
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

  } catch (error: any) {
    console.error('User fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

