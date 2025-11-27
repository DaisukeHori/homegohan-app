import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// セキュリティ上禁止されたフィールド
const FORBIDDEN_PROFILE_FIELDS = ['email', 'avatar_url', 'is_banned', 'role', 'auth_provider'];

// ユーザーのアクティブな献立プランを取得または作成するヘルパー関数
async function getOrCreateActivePlan(supabase: any, userId: string, targetDate?: string): Promise<{ id: string } | null> {
  // まずアクティブなプランを探す
  let { data: activePlan } = await supabase
    .from('meal_plans')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single();

  if (activePlan) return activePlan;

  // アクティブなプランがない場合、既存のプランをアクティブにする
  const { data: existingPlan } = await supabase
    .from('meal_plans')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existingPlan) {
    await supabase
      .from('meal_plans')
      .update({ is_active: true })
      .eq('id', existingPlan.id);
    return existingPlan;
  }

  // 既存プランもない場合は新規作成
  const date = targetDate || new Date().toISOString().split('T')[0];
  const startOfWeek = new Date(date);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);

  const { data: newPlan, error: planError } = await supabase
    .from('meal_plans')
    .insert({
      user_id: userId,
      start_date: startOfWeek.toISOString().split('T')[0],
      end_date: endOfWeek.toISOString().split('T')[0],
      is_active: true,
    })
    .select('id')
    .single();

  if (planError) return null;
  return newPlan;
}

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
      // ==================== 献立関連 ====================
      case 'generate_day_menu': {
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

      case 'create_meal': {
        // 新規食事を登録
        const { date, mealType, dishName, mode, calories, protein, fat, carbs, memo } = action.action_params;
        
        // 献立プランを取得または作成
        const activePlan = await getOrCreateActivePlan(supabase, user.id, date);
        if (!activePlan) {
          result = { error: '献立プランの作成に失敗しました' };
          break;
        }

        let { data: dayData } = await supabase
          .from('meal_plan_days')
          .select('id')
          .eq('meal_plan_id', activePlan.id)
          .eq('day_date', date)
          .single();

        if (!dayData) {
          const { data: newDay } = await supabase
            .from('meal_plan_days')
            .insert({ meal_plan_id: activePlan.id, day_date: date })
            .select('id')
            .single();
          dayData = newDay;
        }

        if (dayData) {
          const { data: newMeal, error: insertError } = await supabase
            .from('planned_meals')
            .insert({
              meal_plan_day_id: dayData.id,
              meal_type: mealType || 'dinner',
              dish_name: dishName,
              mode: mode || 'cook',
              calories_kcal: calories,
              protein_g: protein,
              fat_g: fat,
              carbs_g: carbs,
              memo,
            })
            .select('id')
            .single();
          success = !insertError;
          result = { mealId: newMeal?.id, created: success };
        }
        break;
      }

      case 'update_meal': {
        const { mealId, updates } = action.action_params;
        console.log('update_meal action:', { mealId, updates });
        
        if (!mealId) {
          result = { error: 'mealIdが指定されていません' };
          break;
        }
        
        // セキュリティ: 自分の献立のみ更新可能
        const { data: meal, error: mealFetchError } = await supabase
          .from('planned_meals')
          .select('id, dish_name, meal_plan_days!inner(meal_plans!inner(user_id))')
          .eq('id', mealId)
          .single();

        if (mealFetchError) {
          console.error('Failed to fetch meal for update:', mealFetchError);
          result = { error: `食事の取得に失敗: ${mealFetchError.message}` };
          break;
        }

        if (!meal || (meal as any).meal_plan_days.meal_plans.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        // updated_atを明示的に追加
        const updateData = {
          ...updates,
          updated_at: new Date().toISOString(),
        };

        const { data: updatedMeal, error: updateError } = await supabase
          .from('planned_meals')
          .update(updateData)
          .eq('id', mealId)
          .select('id, dish_name, calories_kcal')
          .single();
        
        if (updateError) {
          console.error('Failed to update meal:', updateError);
          result = { error: `更新に失敗: ${updateError.message}` };
          break;
        }
        
        console.log('Meal updated successfully:', updatedMeal);
        success = true;
        result = { mealId, updated: true, newDishName: updatedMeal?.dish_name };
        break;
      }

      case 'delete_meal': {
        const { mealId } = action.action_params;
        // セキュリティチェック
        const { data: meal } = await supabase
          .from('planned_meals')
          .select('meal_plan_days!inner(meal_plans!inner(user_id))')
          .eq('id', mealId)
          .single();

        if (!meal || (meal as any).meal_plan_days.meal_plans.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('planned_meals')
          .delete()
          .eq('id', mealId);
        success = !deleteError;
        result = { mealId, deleted: success };
        break;
      }

      case 'complete_meal': {
        const { mealId, isCompleted } = action.action_params;
        // セキュリティチェック
        const { data: meal } = await supabase
          .from('planned_meals')
          .select('meal_plan_days!inner(meal_plans!inner(user_id))')
          .eq('id', mealId)
          .single();

        if (!meal || (meal as any).meal_plan_days.meal_plans.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('planned_meals')
          .update({ is_completed: isCompleted !== false })
          .eq('id', mealId);
        success = !updateError;
        result = { mealId, completed: isCompleted !== false };
        break;
      }

      // ==================== 買い物リスト関連 ====================
      case 'add_to_shopping_list': {
        const { items, mealPlanId } = action.action_params;
        
        let planId = mealPlanId;
        if (!planId) {
          const activePlan = await getOrCreateActivePlan(supabase, user.id);
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

      case 'update_shopping_item': {
        const { itemId, updates } = action.action_params;
        // セキュリティチェック - meal_plan経由でuser_idを確認
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('meal_plan_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: plan } = await supabase
            .from('meal_plans')
            .select('user_id')
            .eq('id', item.meal_plan_id)
            .single();
          
          if (!plan || plan.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('shopping_list_items')
          .update(updates)
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, updated: success };
        break;
      }

      case 'delete_shopping_item': {
        const { itemId } = action.action_params;
        // セキュリティチェック
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('meal_plan_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: plan } = await supabase
            .from('meal_plans')
            .select('user_id')
            .eq('id', item.meal_plan_id)
            .single();
          
          if (!plan || plan.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('shopping_list_items')
          .delete()
          .eq('id', itemId);
        success = !deleteError;
        result = { itemId, deleted: success };
        break;
      }

      case 'check_shopping_item': {
        const { itemId, isChecked } = action.action_params;
        // セキュリティチェック
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('meal_plan_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: plan } = await supabase
            .from('meal_plans')
            .select('user_id')
            .eq('id', item.meal_plan_id)
            .single();
          
          if (!plan || plan.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('shopping_list_items')
          .update({ is_checked: isChecked !== false })
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, checked: isChecked !== false };
        break;
      }

      // ==================== 冷蔵庫/パントリー関連 ====================
      case 'add_pantry_item': {
        const { name, quantity, unit, category, expiryDate } = action.action_params;
        
        const activePlan = await getOrCreateActivePlan(supabase, user.id);
        if (!activePlan) {
          result = { error: '献立プランの作成に失敗しました' };
          break;
        }

        const { data: newItem, error: insertError } = await supabase
          .from('pantry_items')
          .insert({
            meal_plan_id: activePlan.id,
            item_name: name,
            quantity,
            unit,
            category: category || 'その他',
            expiry_date: expiryDate,
          })
          .select('id')
          .single();
        success = !insertError;
        result = { itemId: newItem?.id, created: success };
        break;
      }

      case 'update_pantry_item': {
        const { itemId, updates } = action.action_params;
        // セキュリティチェック
        const { data: item } = await supabase
          .from('pantry_items')
          .select('meal_plan_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: plan } = await supabase
            .from('meal_plans')
            .select('user_id')
            .eq('id', item.meal_plan_id)
            .single();
          
          if (!plan || plan.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('pantry_items')
          .update(updates)
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, updated: success };
        break;
      }

      case 'delete_pantry_item': {
        const { itemId } = action.action_params;
        // セキュリティチェック
        const { data: item } = await supabase
          .from('pantry_items')
          .select('meal_plan_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: plan } = await supabase
            .from('meal_plans')
            .select('user_id')
            .eq('id', item.meal_plan_id)
            .single();
          
          if (!plan || plan.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('pantry_items')
          .delete()
          .eq('id', itemId);
        success = !deleteError;
        result = { itemId, deleted: success };
        break;
      }

      // ==================== レシピ関連 ====================
      case 'suggest_recipe': {
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

      case 'like_recipe': {
        const { recipeId } = action.action_params;
        
        // 既にいいね済みかチェック
        const { data: existing } = await supabase
          .from('recipe_likes')
          .select('id')
          .eq('recipe_id', recipeId)
          .eq('user_id', user.id)
          .single();

        if (existing) {
          result = { alreadyLiked: true };
          success = true;
        } else {
          const { error: insertError } = await supabase
            .from('recipe_likes')
            .insert({ recipe_id: recipeId, user_id: user.id });
          success = !insertError;
          result = { liked: success };
        }
        break;
      }

      case 'add_recipe_to_collection': {
        const { recipeId, collectionName } = action.action_params;
        
        // コレクションを取得または作成
        let { data: collection } = await supabase
          .from('recipe_collections')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', collectionName || 'お気に入り')
          .single();

        if (!collection) {
          const { data: newCollection } = await supabase
            .from('recipe_collections')
            .insert({
              user_id: user.id,
              name: collectionName || 'お気に入り',
            })
            .select('id')
            .single();
          collection = newCollection;
        }

        if (collection) {
          const { error: updateError } = await supabase
            .from('recipe_collections')
            .update({
              recipe_ids: supabase.rpc('array_append_unique', {
                arr: [],
                elem: recipeId,
              }),
            })
            .eq('id', collection.id);
          // 簡易的に配列に追加（RPCがない場合の代替）
          const { data: currentCollection } = await supabase
            .from('recipe_collections')
            .select('recipe_ids')
            .eq('id', collection.id)
            .single();
          
          const currentIds = currentCollection?.recipe_ids || [];
          if (!currentIds.includes(recipeId)) {
            const { error: appendError } = await supabase
              .from('recipe_collections')
              .update({ recipe_ids: [...currentIds, recipeId] })
              .eq('id', collection.id);
            success = !appendError;
          } else {
            success = true;
          }
          result = { collectionId: collection.id, added: success };
        }
        break;
      }

      // ==================== 栄養目標関連 ====================
      case 'update_nutrition_target': {
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

      // ==================== 健康目標関連 ====================
      case 'set_health_goal': {
        const { goalType, targetValue, targetUnit, targetDate, description } = action.action_params;
        const { data: newGoal, error: insertError } = await supabase
          .from('health_goals')
          .insert({
            user_id: user.id,
            goal_type: goalType,
            target_value: targetValue,
            target_unit: targetUnit,
            target_date: targetDate,
            description,
            status: 'active',
          })
          .select('id')
          .single();
        success = !insertError;
        result = { goalId: newGoal?.id, created: success };
        break;
      }

      case 'update_health_goal': {
        const { goalId, updates } = action.action_params;
        // セキュリティチェック
        const { data: goal } = await supabase
          .from('health_goals')
          .select('user_id')
          .eq('id', goalId)
          .single();

        if (!goal || goal.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('health_goals')
          .update(updates)
          .eq('id', goalId);
        success = !updateError;
        result = { goalId, updated: success };
        break;
      }

      case 'delete_health_goal': {
        const { goalId } = action.action_params;
        // セキュリティチェック
        const { data: goal } = await supabase
          .from('health_goals')
          .select('user_id')
          .eq('id', goalId)
          .single();

        if (!goal || goal.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('health_goals')
          .delete()
          .eq('id', goalId);
        success = !deleteError;
        result = { goalId, deleted: success };
        break;
      }

      // ==================== 健康記録関連 ====================
      case 'add_health_record': {
        const { date, weight, bodyFatPercentage, systolicBp, diastolicBp, sleepHours, 
                overallCondition, moodScore, stressLevel, stepCount, notes } = action.action_params;
        
        const recordDate = date || new Date().toISOString().split('T')[0];
        
        // 既存レコードがあればupsert
        const { error: upsertError } = await supabase
          .from('health_records')
          .upsert({
            user_id: user.id,
            record_date: recordDate,
            weight,
            body_fat_percentage: bodyFatPercentage,
            systolic_bp: systolicBp,
            diastolic_bp: diastolicBp,
            sleep_hours: sleepHours,
            overall_condition: overallCondition,
            mood_score: moodScore,
            stress_level: stressLevel,
            step_count: stepCount,
            notes,
          }, { onConflict: 'user_id,record_date' });
        success = !upsertError;
        result = { date: recordDate, saved: success };
        break;
      }

      case 'update_health_record': {
        const { date, updates } = action.action_params;
        // セキュリティチェック（user_idで自動的に制限）
        const { error: updateError } = await supabase
          .from('health_records')
          .update(updates)
          .eq('user_id', user.id)
          .eq('record_date', date);
        success = !updateError;
        result = { date, updated: success };
        break;
      }

      // ==================== プロフィール関連（制限付き） ====================
      case 'update_profile_preferences': {
        const { updates } = action.action_params;
        
        // 禁止フィールドを除外
        const safeUpdates: Record<string, any> = {};
        const allowedFields = [
          'nickname', 'age', 'gender', 'height', 'weight', 'target_weight',
          'body_fat_percentage', 'target_body_fat', 'muscle_mass',
          'health_conditions', 'medications', 'fitness_goals',
          'sleep_quality', 'stress_level', 'bowel_movement', 'skin_condition',
          'cold_sensitivity', 'swelling_prone',
          'occupation', 'industry', 'work_style', 'desk_hours_per_day',
          'overtime_frequency', 'business_trip_frequency', 'entertainment_frequency',
          'weekly_exercise_minutes', 'exercise_types',
          'diet_style', 'religious_restrictions', 'diet_flags',
          'cuisine_preferences', 'taste_preferences', 'favorite_ingredients', 'favorite_dishes',
          'cooking_experience', 'specialty_cuisines', 'disliked_cooking',
          'weekday_cooking_minutes', 'weekend_cooking_minutes',
          'meal_prep_ok', 'kitchen_appliances',
          'wake_time', 'sleep_time', 'meal_times',
          'snacking_habit', 'alcohol_frequency', 'smoking', 'caffeine_intake', 'daily_water_ml',
          'family_size', 'has_children', 'children_ages', 'has_elderly',
          'weekly_food_budget', 'shopping_frequency', 'preferred_stores',
          'online_grocery', 'organic_preference',
          'hobbies', 'weekend_activity', 'outdoor_activities',
        ];

        for (const key of Object.keys(updates)) {
          if (allowedFields.includes(key) && !FORBIDDEN_PROFILE_FIELDS.includes(key)) {
            safeUpdates[key] = updates[key];
          }
        }

        if (Object.keys(safeUpdates).length === 0) {
          result = { error: '更新可能なフィールドがありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('user_profiles')
          .update(safeUpdates)
          .eq('id', user.id);
        success = !updateError;
        result = { updated: success, fields: Object.keys(safeUpdates) };
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
