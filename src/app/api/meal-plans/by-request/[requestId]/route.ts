import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toMealPlan } from '@/lib/converter';

export async function GET(
  request: Request,
  { params }: { params: { requestId: string } }
) {
  const supabase = createClient(cookies());
  const { requestId } = params;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // source_request_id で検索
    const { data, error } = await supabase
      .from('meal_plans')
      .select(`
        *,
        meal_plan_days (
          *,
          planned_meals (*)
        ),
        shopping_list_items (*)
      `)
      .eq('source_request_id', requestId)
      .eq('user_id', user.id)
      .single();

    if (error) {
      // まだ作成されていない可能性もあるので404は許容
      if (error.code === 'PGRST116') {
        return NextResponse.json({ mealPlan: null });
      }
      throw error;
    }

    // データ変換 (snake_case -> camelCase)
    const mealPlan = toMealPlan(data);

    return NextResponse.json({ mealPlan });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


