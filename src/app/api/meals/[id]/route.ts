import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 特定の食事を取得（planned_mealsベース）
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // planned_mealsとuser_daily_mealsをJOINして取得
    const { data, error } = await supabase
      .from('planned_meals')
      .select(`
        *,
        user_daily_meals!inner(
          day_date,
          user_id
        )
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 食事を更新（planned_mealsベース）
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    
    // 許可されたフィールドのみ更新
    const allowedFields = [
      'dish_name', 'mode', 'description', 'image_url', 'ingredients',
      'calories_kcal', 'protein_g', 'fat_g', 'carbs_g',
      'is_completed', 'completed_at', 'dishes', 'is_simple', 'cooking_time_minutes'
    ];
    
    const updateData: Record<string, any> = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updateData[key] = body[key];
      }
    }
    updateData.updated_at = new Date().toISOString();

    // まずユーザーの所有確認
    const { data: existing } = await supabase
      .from('planned_meals')
      .select(`
        id,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 食事を削除（planned_mealsベース）
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // まずユーザーの所有確認
    const { data: existing } = await supabase
      .from('planned_meals')
      .select(`
        id,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    const { error } = await supabase
      .from('planned_meals')
      .delete()
      .eq('id', params.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
