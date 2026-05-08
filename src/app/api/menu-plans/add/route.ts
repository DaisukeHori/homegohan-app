import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { awardBadge } from '@/lib/badges/awardBadge';

const ADMIN_ROLES = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'] as const;

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const body = await request.json();
    const searchParams = new URL(request.url).searchParams;
    const source = searchParams.get('source') ?? 'normal';

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: '認証が必要です' } },
        { status: 401 },
      );
    }

    const isSandbox = body.sandbox === true;

    if (isSandbox) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handson_tour_completed_at, handson_tour_skipped_at, roles')
        .eq('user_id', user.id)
        .single();

      if (profile?.handson_tour_completed_at || profile?.handson_tour_skipped_at) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'already_finished' } },
          { status: 409 },
        );
      }

      const hasAdminRole = Array.isArray(profile?.roles) &&
        profile.roles.some((r: string) => (ADMIN_ROLES as readonly string[]).includes(r));
      if (hasAdminRole) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'admin_role' } },
          { status: 403 },
        );
      }

      const { data: hasActivity } = await supabase
        .rpc('user_has_non_sandbox_activity', { p_user_id: user.id });
      if (hasActivity) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'existing_user' } },
          { status: 409 },
        );
      }
    }

    const insertData: Record<string, unknown> = {
      user_id: user.id,
      is_sandbox: isSandbox,
      source: source,
    };

    const allowedFields = [
      'week_start_date',
      'menu_data',
      'status',
      'generation_id',
    ];
    for (const field of allowedFields) {
      if (field in body && body[field] !== undefined) {
        insertData[field] = body[field];
      }
    }

    const { data: newMenu, error: insertError } = await supabase
      .from('weekly_menus')
      .insert(insertData)
      .select()
      .single();

    if (insertError) {
      console.error('weekly_menus insert error:', insertError);
      return NextResponse.json(
        { error: { code: 'internal_error', message: 'サーバーエラーが発生しました', details: insertError.message } },
        { status: 500 },
      );
    }

    // バッジ付与(副次処理: 失敗しても主処理は成功)
    let badgeAwarded: { code: string; name: string | null; obtained_at: string | null; icon_url: string | null } | null = null;
    try {
      const badgeResult = await awardBadge(supabase, user.id, 'planner');
      if (badgeResult.awarded) {
        console.info('planner badge awarded', { userId: user.id });
        badgeAwarded = {
          code: 'planner',
          name: badgeResult.name,
          obtained_at: badgeResult.obtained_at,
          icon_url: badgeResult.icon_url,
        };
      }
    } catch (badgeErr) {
      console.error('planner badge award failed (non-fatal):', badgeErr);
    }

    return NextResponse.json({ success: true, menuId: newMenu.id, badge_awarded: badgeAwarded });
  } catch (err: unknown) {
    console.error('menu-plans/add error:', err);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
