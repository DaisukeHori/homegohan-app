import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// モデレーション対象一覧取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'pending';
    const flagType = searchParams.get('flag_type');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = (page - 1) * limit;

    // 食事フラグ
    let mealFlagsQuery = supabase
      .from('moderation_flags')
      .select(`
        id,
        meal_id,
        user_id,
        flag_type,
        reason,
        status,
        created_at,
        resolved_by,
        resolved_at,
        resolution_note
      `, { count: 'exact' })
      .eq('status', status);

    if (flagType) {
      mealFlagsQuery = mealFlagsQuery.eq('flag_type', flagType);
    }

    const { data: mealFlags, count: mealCount } = await mealFlagsQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // レシピフラグ
    let recipeFlagsQuery = supabase
      .from('recipe_flags')
      .select(`
        id,
        recipe_id,
        reporter_id,
        flag_type,
        reason,
        status,
        created_at,
        reviewed_by,
        reviewed_at
      `, { count: 'exact' })
      .eq('status', status);

    if (flagType) {
      recipeFlagsQuery = recipeFlagsQuery.eq('flag_type', flagType);
    }

    const { data: recipeFlags, count: recipeCount } = await recipeFlagsQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // AIコンテンツフラグ
    const { data: aiFlags, count: aiCount } = await supabase
      .from('ai_content_logs')
      .select('*', { count: 'exact' })
      .eq('flagged', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    return NextResponse.json({
      mealFlags: (mealFlags || []).map((f: any) => ({
        id: f.id,
        type: 'meal',
        targetId: f.meal_id,
        userId: f.user_id,
        flagType: f.flag_type,
        reason: f.reason,
        status: f.status,
        createdAt: f.created_at,
        resolvedBy: f.resolved_by,
        resolvedAt: f.resolved_at,
        resolutionNote: f.resolution_note,
      })),
      recipeFlags: (recipeFlags || []).map((f: any) => ({
        id: f.id,
        type: 'recipe',
        targetId: f.recipe_id,
        reporterId: f.reporter_id,
        flagType: f.flag_type,
        reason: f.reason,
        status: f.status,
        createdAt: f.created_at,
        reviewedBy: f.reviewed_by,
        reviewedAt: f.reviewed_at,
      })),
      aiFlags: (aiFlags || []).map((f: any) => ({
        id: f.id,
        type: 'ai_content',
        userId: f.user_id,
        contentType: f.content_type,
        outputContent: f.output_content?.substring(0, 200),
        flagReason: f.flag_reason,
        createdAt: f.created_at,
      })),
      counts: {
        meal: mealCount || 0,
        recipe: recipeCount || 0,
        ai: aiCount || 0,
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

