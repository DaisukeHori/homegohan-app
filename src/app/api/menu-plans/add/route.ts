import { NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { awardBadge } from '@/lib/badges/awardBadge';
import type { Database, Json } from '@/types/database.types';

const ADMIN_ROLES = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'] as const;

type WeeklyMenuRequestInsert = Database['public']['Tables']['weekly_menu_requests']['Insert'];
type WeeklyMenuInsert = Database['public']['Tables']['weekly_menus']['Insert'];

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
      // #1025 round-2: user_profiles の PK は id (auth.users(id) 参照) であり
      // user_id 列は存在しない。.eq('user_id', ...) だと PostgREST が 42703 を返すが、
      // error を握りつぶして data のみ見ると profile が常に undefined になり
      // 以下の 2 ゲート (already_finished / admin_role) が無条件で素通りする
      // fail-open バグだった。fail-closed (判定不能なら拒否) に修正する。
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('handson_tour_completed_at, handson_tour_skipped_at, roles')
        .eq('id', user.id)
        .single();

      if (profileError || !profile) {
        console.error('user_profiles fetch error (sandbox eligibility):', profileError);
        return NextResponse.json(
          { error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' } },
          { status: 404 },
        );
      }

      if (profile.handson_tour_completed_at || profile.handson_tour_skipped_at) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'already_finished' } },
          { status: 409 },
        );
      }

      const hasAdminRole = Array.isArray(profile.roles) &&
        profile.roles.some((r: string) => (ADMIN_ROLES as readonly string[]).includes(r));
      if (hasAdminRole) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'admin_role' } },
          { status: 403 },
        );
      }

      const { data: hasActivity, error: activityError } = await supabase
        .rpc('user_has_non_sandbox_activity');
      if (activityError) {
        // 判定不能は拒否側に倒す(fail-closed、#1025 round-3)
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'existing_user' } },
          { status: 409 },
        );
      }
      if (hasActivity) {
        return NextResponse.json(
          { error: { code: 'sandbox_not_eligible', message: 'サンドボックスの利用条件を満たしていません', reason: 'existing_user' } },
          { status: 409 },
        );
      }
    }

    // weekly_menus の実列は content(jsonb NOT NULL) / request_id(uuid NOT NULL, FK) /
    // start_date(date NOT NULL) / user_id のみ (#1025)。body は MOCK_MENU_RESPONSE 由来の
    // フラットな献立データ (dish_name/calories/...) であり、旧実装が使っていた
    // week_start_date/menu_data/status/generation_id/is_sandbox という列は実在しない。
    const { sandbox: _sandbox, source: _bodySource, ...menuContent } = body as Record<string, unknown>;
    const content = { ...menuContent, source } as Json;

    const offsetDays = typeof body.date_offset_days === 'number' ? body.date_offset_days : 0;
    const startDate = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // weekly_menus.request_id は weekly_menu_requests への NOT NULL FK。
    // ここでの追加は AI 生成フローを経ない単発追加なので、コンテナ用にリクエストを
    // 1件作る。status は非終端の 'pending' で作成し(cron の claim_menu_request は
    // status='queued'/'processing' のみ拾うため 'pending' が誤って処理されることはない)、
    // weekly_menus insert の成否を見てから 'completed'/'failed' に更新する
    // (#1025 round-2: 先に 'completed' で作ると weekly_menus insert 失敗時に
    // 「完了扱いだが対応献立が無い」孤児行が残るため)。
    const requestInsert: WeeklyMenuRequestInsert = {
      user_id: user.id,
      start_date: startDate,
      status: 'pending',
    };

    const { data: requestRow, error: requestError } = await supabase
      .from('weekly_menu_requests')
      .insert(requestInsert)
      .select('id')
      .single();

    if (requestError || !requestRow) {
      console.error('weekly_menu_requests insert error:', requestError);
      return NextResponse.json(
        { error: { code: 'internal_error', message: 'サーバーエラーが発生しました', details: requestError?.message } },
        { status: 500 },
      );
    }

    const insertData: WeeklyMenuInsert = {
      user_id: user.id,
      request_id: requestRow.id,
      start_date: startDate,
      content,
    };

    // weekly_menus には SELECT 用の RLS ポリシーしか存在せず INSERT ポリシーが無いため、
    // authenticated セッションでの insert は常に RLS 違反 (42501) になる。ここまでで
    // sandbox 適格性など本人認可チェックは完了済みなので、この insert のみ service_role を
    // 使う (#1025: migration 禁止のためポリシー追加ではなくコード側で対応。#1028 と同一パターン)。
    const supabaseAdmin = getSupabaseAdmin();
    const { data: newMenu, error: insertError } = await supabaseAdmin
      .from('weekly_menus')
      .insert(insertData)
      .select()
      .single();

    if (insertError) {
      console.error('weekly_menus insert error:', insertError);
      // 補償: 対応する献立を作れなかった request を 'pending' のまま孤児にしない
      const { error: failCompensationError } = await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: insertError.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestRow.id);
      if (failCompensationError) {
        console.error('weekly_menu_requests failed-compensation update error:', failCompensationError);
      }
      return NextResponse.json(
        { error: { code: 'internal_error', message: 'サーバーエラーが発生しました', details: insertError.message } },
        { status: 500 },
      );
    }

    // weekly_menus insert 成功 → request を completed に確定(非致命: 失敗しても主処理は成功のまま)
    const { error: completeError } = await supabase
      .from('weekly_menu_requests')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', requestRow.id);
    if (completeError) {
      console.error('weekly_menu_requests completion update failed (non-fatal):', completeError);
    }

    // バッジ付与(副次処理: 失敗しても主処理は成功)。
    // user_badges は RLS が SELECT のみで INSERT ポリシーが無いため、session client だと
    // 常に 42501 で throw → catch で握りつぶされ badge_awarded が常に null になっていた
    // (#1025 round-2)。weekly_menus と同じく service_role を使う。userId は認証済みの
    // user.id を明示引数で渡す (awardBadge は auth.uid() に依存しないため他人への付与は不可)。
    let badgeAwarded: { code: string; name: string | null; obtained_at: string | null; icon_url: string | null } | null = null;
    try {
      const badgeResult = await awardBadge(supabaseAdmin, user.id, 'planner');
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

    return NextResponse.json({ success: true, menu_id: newMenu.id, badge_awarded: badgeAwarded });
  } catch (err: unknown) {
    console.error('menu-plans/add error:', err);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } },
      { status: 500 },
    );
  }
}
