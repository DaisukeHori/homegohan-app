import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// アクション実行
export async function POST(
  request: Request,
  { params }: { params: { actionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // actionIdはメッセージIDまたはアクションログIDの可能性がある
    // まずアクションログIDとして検索
    let { data: action, error: actionError } = await supabase
      .from('ai_action_logs')
      .select(`
        *,
        ai_consultation_sessions!inner(user_id)
      `)
      .eq('id', params.actionId)
      .single();

    // 見つからない場合はメッセージIDとして検索
    if (actionError || !action) {
      const { data: actionByMessage, error: msgError } = await supabase
        .from('ai_action_logs')
        .select(`
          *,
          ai_consultation_sessions!inner(user_id)
        `)
        .eq('message_id', params.actionId)
        .eq('status', 'pending')
        .single();
      
      if (msgError || !actionByMessage) {
        return NextResponse.json({ error: 'Action not found' }, { status: 404 });
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 });
    }

    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action.status !== 'pending') {
      return NextResponse.json({ error: 'Action already processed' }, { status: 400 });
    }

    let result: any = null;
    let success = false;

    // アクションタイプに応じて実行
    switch (action.action_type) {
      case 'generate_day_menu': {
        // 日次献立生成
        const { date } = action.action_params;
        const { error: invokeError } = await supabase.functions.invoke('generate-single-meal', {
          body: {
            date,
            userId: user.id,
            mealTypes: ['breakfast', 'lunch', 'dinner'],
          },
        });
        success = !invokeError;
        result = { date, status: success ? 'started' : 'failed' };
        break;
      }

      case 'generate_week_menu': {
        // 週間献立生成
        const { startDate } = action.action_params;
        const { error: invokeError } = await supabase.functions.invoke('generate-weekly-menu', {
          body: {
            startDate,
            userId: user.id,
          },
        });
        success = !invokeError;
        result = { startDate, status: success ? 'started' : 'failed' };
        break;
      }

      case 'update_meal': {
        // 献立更新
        const { mealId, updates } = action.action_params;
        const { error: updateError } = await supabase
          .from('planned_meals')
          .update(updates)
          .eq('id', mealId);
        success = !updateError;
        result = { mealId, updated: success };
        break;
      }

      case 'add_to_shopping_list': {
        // 買い物リストに追加
        const { items, mealPlanId } = action.action_params;
        
        // アクティブなmeal_planを取得
        let planId = mealPlanId;
        if (!planId) {
          const { data: activePlan } = await supabase
            .from('meal_plans')
            .select('id')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .single();
          planId = activePlan?.id;
        }

        if (planId && items?.length > 0) {
          const insertData = items.map((item: any) => ({
            meal_plan_id: planId,
            item_name: item.name,
            quantity: item.quantity,
            category: item.category || 'その他',
            is_checked: false,
          }));
          const { error: insertError } = await supabase
            .from('shopping_list_items')
            .insert(insertData);
          success = !insertError;
        }
        result = { itemsAdded: items?.length || 0 };
        break;
      }

      case 'suggest_recipe': {
        // レシピ提案（検索して返す）
        const { keywords, cuisineType } = action.action_params;
        let query = supabase
          .from('recipes')
          .select('id, name, description, image_url, cooking_time_minutes')
          .eq('is_public', true);
        
        if (keywords) {
          query = query.ilike('name', `%${keywords}%`);
        }
        if (cuisineType) {
          query = query.eq('cuisine_type', cuisineType);
        }

        const { data: recipes, error: recipeError } = await query.limit(5);
        success = !recipeError;
        result = { recipes: recipes || [] };
        break;
      }

      case 'update_nutrition_target': {
        // 栄養目標更新
        const { targets } = action.action_params;
        const { error: updateError } = await supabase
          .from('nutrition_targets')
          .upsert({
            user_id: user.id,
            ...targets,
          }, { onConflict: 'user_id' });
        success = !updateError;
        result = { updated: success };
        break;
      }

      case 'set_health_goal': {
        // 健康目標設定
        const { goalType, targetValue, targetDate } = action.action_params;
        const { error: insertError } = await supabase
          .from('health_goals')
          .insert({
            user_id: user.id,
            goal_type: goalType,
            target_value: targetValue,
            target_date: targetDate,
            status: 'active',
          });
        success = !insertError;
        result = { goalCreated: success };
        break;
      }

      default:
        return NextResponse.json({ error: 'Unknown action type' }, { status: 400 });
    }

    // アクションステータスを更新
    await supabase
      .from('ai_action_logs')
      .update({
        status: success ? 'executed' : 'failed',
        result,
        executed_at: new Date().toISOString(),
      })
      .eq('id', action.id);

    return NextResponse.json({
      success,
      result,
      actionType: action.action_type,
    });

  } catch (error: any) {
    console.error('Action execution error:', error);

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// アクション拒否
export async function DELETE(
  request: Request,
  { params }: { params: { actionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // メッセージIDからアクションを検索
    const { data: action } = await supabase
      .from('ai_action_logs')
      .select('id')
      .eq('message_id', params.actionId)
      .eq('status', 'pending')
      .single();

    const actionId = action?.id || params.actionId;

    const { error } = await supabase
      .from('ai_action_logs')
      .update({ status: 'rejected' })
      .eq('id', actionId);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Action rejection error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

