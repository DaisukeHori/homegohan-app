import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const ADMIN_ROLES = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'] as const;

export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: '認証が必要です' } },
        { status: 401 },
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('roles, handson_tour_completed_at')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' } },
        { status: 404 },
      );
    }

    const hasAdminRole = Array.isArray(profile.roles) &&
      profile.roles.some((r: string) => (ADMIN_ROLES as readonly string[]).includes(r));

    if (hasAdminRole) {
      return NextResponse.json(
        { error: { code: 'not_eligible', message: '対象外のユーザーです', reason: 'admin_role' } },
        { status: 403 },
      );
    }

    const { data: hasActivity } = await supabase
      .rpc('user_has_non_sandbox_activity', { p_user_id: user.id });

    if (hasActivity && !profile.handson_tour_completed_at) {
      return NextResponse.json(
        { error: { code: 'not_eligible', message: '対象外のユーザーです', reason: 'existing_user' } },
        { status: 409 },
      );
    }

    const { data: result, error: rpcError } = await supabase
      .rpc('complete_handson_tour', { p_user_id: user.id });

    if (rpcError) {
      console.error('complete_handson_tour RPC error:', rpcError);
      return NextResponse.json(
        { error: { code: 'internal_error', message: 'サーバーエラーが発生しました', details: rpcError.message } },
        { status: 500 },
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error('handson-tour/complete error:', err);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
