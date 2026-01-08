import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { fromUserProfile } from '@/lib/converter'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    
    // マッピング
    const updates: any = {
      id: user.id,
      updated_at: new Date().toISOString(),
    };

    if (body.nickname) updates.nickname = body.nickname;
    if (body.gender) updates.gender = body.gender;
    if (body.lifestyle) updates.lifestyle = body.lifestyle;
    if (body.goal) updates.goal_text = body.goal;
    
    // 追加項目
    if (body.age) updates.age = parseInt(body.age);
    if (body.age) updates.age_group = `${Math.floor(parseInt(body.age) / 10) * 10}s`;
    if (body.occupation) updates.occupation = body.occupation;
    if (body.height) updates.height = parseFloat(body.height);
    if (body.weight) updates.weight = parseFloat(body.weight);

    // 栄養目標・運動関連
    if (body.nutritionGoal) updates.nutrition_goal = body.nutritionGoal;
    if (body.weightChangeRate) updates.weight_change_rate = body.weightChangeRate;
    if (body.exerciseTypes) updates.exercise_types = body.exerciseTypes;
    if (body.exerciseFrequency) updates.exercise_frequency = parseInt(body.exerciseFrequency);
    if (body.exerciseIntensity) updates.exercise_intensity = body.exerciseIntensity;
    if (body.exerciseDurationPerSession) updates.exercise_duration_per_session = parseInt(body.exerciseDurationPerSession);
    if (body.workStyle) updates.work_style = body.workStyle;
    if (body.healthConditions) updates.health_conditions = body.healthConditions;
    if (body.medications) updates.medications = body.medications;
    if (body.fitnessGoals) updates.fitness_goals = body.fitnessGoals;
    if (body.dietFlags) updates.diet_flags = body.dietFlags;
    if (body.cookingExperience) updates.cooking_experience = body.cookingExperience;
    if (body.weekdayCookingMinutes) updates.weekday_cooking_minutes = parseInt(body.weekdayCookingMinutes);
    if (body.cuisinePreferences) updates.cuisine_preferences = body.cuisinePreferences;
    if (body.familySize) updates.family_size = parseInt(body.familySize);
    if (body.servingsConfig) updates.servings_config = body.servingsConfig;
    if (body.radarChartNutrients) updates.radar_chart_nutrients = body.radarChartNutrients;

    // デフォルト値の補完（必須カラムエラー回避）
    if (!updates.nickname) updates.nickname = 'Guest'; 
    if (!updates.age_group && !updates.age) updates.age_group = 'unspecified';
    if (!updates.gender) updates.gender = 'unspecified';

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert(updates)
      .select()
      .single()

    if (error) {
      console.error('Profile update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    
    // fromUserProfile を使用して camelCase -> snake_case 変換
    const updates = fromUserProfile(body);
    
    // 年齢から年代を自動計算
    if (body.age && !body.ageGroup) {
      const age = typeof body.age === 'number' ? body.age : parseInt(body.age);
      if (!isNaN(age)) {
        updates.age_group = `${Math.floor(age / 10) * 10}s`;
      }
    }
    
    // プロファイル完成度を計算
    updates.profile_completeness = calculateProfileCompleteness(body);
    updates.last_profile_update = new Date().toISOString();

    const { data, error } = await supabase
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: any) {
    console.error("API Error (PUT /api/profile):", error);
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// プロファイル完成度を計算
function calculateProfileCompleteness(profile: any): number {
  const fields = [
    // 基本情報 (20%)
    { key: 'nickname', weight: 4 },
    { key: 'age', weight: 4 },
    { key: 'gender', weight: 4 },
    { key: 'height', weight: 4 },
    { key: 'weight', weight: 4 },
    
    // 目標 (15%)
    { key: 'goalText', weight: 5 },
    { key: 'fitnessGoals', weight: 5, isArray: true },
    { key: 'targetWeight', weight: 5 },
    
    // 仕事・生活 (15%)
    { key: 'occupation', weight: 5 },
    { key: 'workStyle', weight: 5 },
    { key: 'weeklyExerciseMinutes', weight: 5 },
    
    // 健康 (15%)
    { key: 'healthConditions', weight: 5, isArray: true },
    { key: 'sleepQuality', weight: 5 },
    { key: 'stressLevel', weight: 5 },
    
    // 食事制限 (15%)
    { key: 'dietFlags', weight: 5, isObject: true },
    { key: 'dietStyle', weight: 5 },
    { key: 'dislikedCookingMethods', weight: 5, isArray: true },
    
    // 調理環境 (10%)
    { key: 'cookingExperience', weight: 5 },
    { key: 'weekdayCookingMinutes', weight: 5 },
    
    // 嗜好 (10%)
    { key: 'cuisinePreferences', weight: 5, isObject: true },
    { key: 'favoriteIngredients', weight: 5, isArray: true },
  ];
  
  let totalWeight = 0;
  let earnedWeight = 0;
  
  for (const field of fields) {
    totalWeight += field.weight;
    const value = profile[field.key];
    
    if (field.isArray) {
      if (Array.isArray(value) && value.length > 0) {
        earnedWeight += field.weight;
      }
    } else if (field.isObject) {
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        earnedWeight += field.weight;
      }
    } else {
      if (value !== null && value !== undefined && value !== '' && value !== 'unspecified') {
        earnedWeight += field.weight;
      }
    }
  }
  
  return Math.round((earnedWeight / totalWeight) * 100);
}
