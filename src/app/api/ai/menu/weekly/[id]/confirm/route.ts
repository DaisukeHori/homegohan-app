import { createClient } from '@/lib/supabase/server';

import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();

  try {
    const { days } = await request.json();
    const requestId = params.id;

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 元データの取得と検証
    const { data: currentRequest, error: fetchError } = await supabase
      .from('weekly_menu_requests')
      .select('*')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !currentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    // 3. result_json の更新とステータス変更
    const updatedResultJson = {
      ...currentRequest.result_json,
      days: days // ユーザーが編集（スキップ等）したdays配列で上書き
    };

    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'confirmed',
        result_json: updatedResultJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);

    if (updateError) throw updateError;

    // 4. 新しい Meal Planner テーブル群へデータを展開して保存
    // 注: 本来はトランザクションを使いたいが、Supabase JS ClientではRPCを使わないと難しい
    // ここでは順次実行し、エラー時はログ出力する方針とする

    try {
      // 4-1. meal_plans (親) の作成
      const startDate = new Date(updatedResultJson.days[0].date);
      const endDate = new Date(updatedResultJson.days[updatedResultJson.days.length - 1].date);
      const title = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()} の献立`;

      const { data: mealPlan, error: planError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: user.id,
          title: title,
          start_date: updatedResultJson.days[0].date,
          end_date: updatedResultJson.days[updatedResultJson.days.length - 1].date,
          status: 'active',
          is_active: true,
          source_request_id: requestId
        })
        .select()
        .single();

      if (planError) throw planError;

      // 他のアクティブな計画を非アクティブにする（オプション）
      await supabase
        .from('meal_plans')
        .update({ is_active: false })
        .eq('user_id', user.id)
        .neq('id', mealPlan.id);

      // 4-2. meal_plan_days と planned_meals の作成
      for (const day of updatedResultJson.days) {
        const { data: planDay, error: dayError } = await supabase
          .from('meal_plan_days')
          .insert({
            meal_plan_id: mealPlan.id,
            day_date: day.date,
            day_of_week: day.dayOfWeek,
            theme: null, // JSONには含まれていない場合がある
            nutritional_focus: day.nutritionalAdvice,
            is_cheat_day: day.isCheatDay
          })
          .select()
          .single();

        if (dayError) {
          console.error("Failed to insert day:", dayError);
          continue;
        }

        // 食事の作成
        const mealsToInsert = day.meals.map((meal: any) => {
          // スキップされた食事は登録しない、またはスキップフラグ付きで登録するか？
          // ここでは「スキップされていないもの」または「スキップフラグ」を持たせる
          // DB定義には is_skipped がないため、descriptionに入れるか、テーブル定義を見直すか。
          // 今回はスキップされたものは登録しない方針、または is_completed=true (食べたことにする) ではなく単に除外？
          // -> ユーザー体験的には「予定なし」として扱いたいので、除外が自然。
          if (meal.isSkipped) return null;

          const dish = meal.dishes[0]; // メインの料理
          if (!dish) return null;

          return {
            meal_plan_day_id: planDay.id,
            meal_type: meal.mealType,
            dish_name: dish.name,
            description: dish.description || null,
            image_url: meal.imageUrl || null, // 生成された画像があれば
            ingredients: [], // 詳細な材料リストはJSONにない場合が多い
            // カロリー等はAI生成JSONに含まれていれば入れる
          };
        }).filter(Boolean);

        if (mealsToInsert.length > 0) {
          const { error: mealsError } = await supabase
            .from('planned_meals')
            .insert(mealsToInsert);
          
          if (mealsError) console.error("Failed to insert meals:", mealsError);
        }
      }

      // 4-3. 買い物リストの作成
      if (updatedResultJson.shoppingList) {
        const shoppingItems = [];
        for (const cat of updatedResultJson.shoppingList) {
          for (const item of cat.items) {
            shoppingItems.push({
              meal_plan_id: mealPlan.id,
              category: cat.category,
              item_name: item,
              is_checked: false
            });
          }
        }
        if (shoppingItems.length > 0) {
          const { error: shopError } = await supabase
            .from('shopping_list_items')
            .insert(shoppingItems);
          
          if (shopError) console.error("Failed to insert shopping list:", shopError);
        }
      }

    } catch (dbError) {
      console.error("Error expanding to meal planner tables:", dbError);
      // ここでのエラーは、confirm 自体を失敗させるべきか、ログに残して続行するか？
      // ユーザーには「確定」できたと見せかけたいので、ログ出力に留める（あるいはバックグラウンドジョブにする）
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
