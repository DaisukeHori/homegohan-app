import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// リクエストのステータスを確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');
  const now = new Date();
  const staleMinutes = 20;
  const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000);

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, error_message, updated_at, mode, start_date, target_meal_id')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .single();

    if (error) throw error;

    if (!request) {
      return NextResponse.json({
        status: 'failed',
        errorMessage: 'Request not found',
        updatedAt: new Date().toISOString(),
      });
    }

    const updatedAt = request.updated_at ? new Date(request.updated_at) : null;
    const isStale = (request.status === 'pending' || request.status === 'processing')
      && updatedAt
      && updatedAt < staleBefore;
    if (isStale) {
      // stale リクエストを failed に更新
      const { error: staleError } = await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: 'stale_request_timeout',
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('user_id', user.id);
      if (staleError) {
        console.error('Failed to mark stale request as failed:', staleError);
      }
      
      // 関連する planned_meals の is_generating もクリア
      if (request.mode === 'single' || request.mode === 'regenerate') {
        // 単一食事の場合は target_meal_id を使う
        if (request.target_meal_id) {
          const { error: mealUpdateError } = await supabase
            .from('planned_meals')
            .update({
              is_generating: false,
              dish_name: '生成に失敗しました',
              updated_at: new Date().toISOString(),
            })
            .eq('id', request.target_meal_id);
          
          if (mealUpdateError) {
            console.error('Failed to clear is_generating for stale meal:', mealUpdateError);
          }
        }
      } else if (request.mode === 'weekly' || !request.mode) {
        // 週間献立の場合は start_date から meal_plan を特定
        if (request.start_date) {
          const { data: mealPlan } = await supabase
            .from('meal_plans')
            .select('id')
            .eq('user_id', user.id)
            .eq('start_date', request.start_date)
            .maybeSingle();
          
          if (mealPlan?.id) {
            const { data: days } = await supabase
              .from('meal_plan_days')
              .select('id')
              .eq('meal_plan_id', mealPlan.id);
            
            if (days && days.length > 0) {
              const dayIds = days.map(d => d.id);
              const { error: mealUpdateError } = await supabase
                .from('planned_meals')
                .update({
                  is_generating: false,
                  dish_name: '生成に失敗しました',
                  updated_at: new Date().toISOString(),
                })
                .in('meal_plan_day_id', dayIds)
                .eq('is_generating', true);
              
              if (mealUpdateError) {
                console.error('Failed to clear is_generating for stale weekly meals:', mealUpdateError);
              }
            }
          }
        }
      }
      
      return NextResponse.json({
        status: 'failed',
        errorMessage: 'stale_request_timeout',
        updatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      status: request.status,
      errorMessage: request.error_message,
      updatedAt: request.updated_at,
    });

  } catch (error: any) {
    console.error('Status check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
