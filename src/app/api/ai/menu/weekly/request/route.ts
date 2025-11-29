import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

// 日付を1日進める
function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

// 今日の日付を取得（ローカルタイムゾーン）
function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { startDate, note, familySize, cheatDay, preferences } = await request.json();

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. meal_planを取得または作成
    let { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (planError || !mealPlan) {
      // meal_planが存在しない場合は作成
      const { data: newPlan, error: createError } = await supabase
        .from('meal_plans')
        .insert({ user_id: user.id, is_active: true })
        .select('id')
        .single();
      
      if (createError) throw new Error(`Failed to create meal_plan: ${createError.message}`);
      mealPlan = newPlan;
    }

    // 3. 7日×3食のプレースホルダーレコードを作成（is_generating=true）
    const todayStr = getTodayStr();
    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    const generatingMealIds: string[] = [];

    for (let i = 0; i < 7; i++) {
      const dateStr = addDays(startDate, i);
      // 今日以降の日付のみ生成対象
      if (dateStr >= todayStr) {
        // meal_plan_dayを作成または取得
        let mealPlanDayId: string;
        const { data: existingDay } = await supabase
          .from('meal_plan_days')
          .select('id')
          .eq('meal_plan_id', mealPlan.id)
          .eq('day_date', dateStr)
          .single();

        if (existingDay) {
          mealPlanDayId = existingDay.id;
          // 既存の食事を削除
          await supabase
            .from('planned_meals')
            .delete()
            .eq('meal_plan_day_id', mealPlanDayId);
        } else {
          const { data: newDay, error: dayError } = await supabase
            .from('meal_plan_days')
            .insert({
              meal_plan_id: mealPlan.id,
              day_date: dateStr,
            })
            .select('id')
            .single();
          
          if (dayError) throw new Error(`Failed to create meal_plan_day: ${dayError.message}`);
          mealPlanDayId = newDay.id;
        }

        // 各食事タイプのプレースホルダーを作成
        for (const mealType of mealTypes) {
          const { data: newMeal, error: mealError } = await supabase
            .from('planned_meals')
            .insert({
              meal_plan_day_id: mealPlanDayId,
              meal_type: mealType,
              dish_name: '生成中...',
              is_generating: true,
              mode: 'cook',
            })
            .select('id')
            .single();
          
          if (mealError) {
            console.error(`Failed to create placeholder for ${dateStr} ${mealType}:`, mealError);
          } else if (newMeal) {
            generatingMealIds.push(newMeal.id);
          }
        }
      }
    }
    
    console.log(`📝 Created ${generatingMealIds.length} placeholder meals`);

    // 4. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'weekly',
        status: 'processing',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    // 5. プレースホルダーのIDを即座に返す（Edge Functionは非同期で呼び出し）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    console.log('🚀 Calling Edge Function generate-weekly-menu...');
    
    // Edge Functionを非同期で呼び出し（完了を待たない）
    fetch(`${supabaseUrl}/functions/v1/generate-weekly-menu`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userId: user.id,
        startDate,
        note,
        familySize,
        cheatDay,
        preferences,
        requestId: requestData.id,
        mealPlanId: mealPlan.id,
        generatingMealIds, // プレースホルダーのIDを渡す
      }),
    }).catch(err => {
      console.error('❌ Edge Function call error:', err.message);
    });

    // プレースホルダーのIDを即座に返す
    return NextResponse.json({ 
      status: 'processing',
      message: 'Generation started',
      requestId: requestData.id,
      generatingMealIds, // 生成中のmeal IDを返す
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
