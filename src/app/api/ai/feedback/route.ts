import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * 献立に対するAIフィードバックを生成
 * planned_mealsベース
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { plannedMealId } = await request.json()

    if (!plannedMealId) {
      return NextResponse.json({ error: 'plannedMealId is required' }, { status: 400 })
    }

    // 献立データを取得
    const { data: meal, error: mealError } = await supabase
      .from('planned_meals')
      .select(`
        *,
        meal_plan_days!inner(
          meal_plans!inner(user_id)
        )
      `)
      .eq('id', plannedMealId)
      .eq('meal_plan_days.meal_plans.user_id', user.id)
      .single()

    if (mealError || !meal) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 })
    }

    // TODO: OpenAI GPTを使用してフィードバックを生成
    // 現在はモックデータ
    const feedbackText = generateMockFeedback(meal)
    const adviceText = generateMockAdvice(meal)

    // planned_mealsのmemo/descriptionにフィードバックを追加することも可能
    // ここでは単純にレスポンスとして返す

    return NextResponse.json({ 
      feedback: {
        plannedMealId,
        feedbackText,
        adviceText,
        modelName: "gpt-4o-mini",
      }
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// モックフィードバック生成
function generateMockFeedback(meal: any): string {
  const mode = meal.mode || 'cook'
  const calories = meal.calories_kcal || 0
  
  if (mode === 'cook' || mode === 'quick') {
    if (calories < 400) {
      return "軽めの食事ですね！間食を控えめにすればダイエットにも効果的です。"
    } else if (calories < 700) {
      return "バランスの良い食事です！自炊は健康的な食生活の基本ですね。"
    } else {
      return "しっかりとした食事ですね！活動量が多い日にはぴったりです。"
    }
  } else if (mode === 'buy') {
    return "お惣菜も上手に活用していますね！忙しい日の強い味方です。"
  } else if (mode === 'out') {
    return "外食も時には必要ですね！楽しんでください。"
  }
  
  return "記録ありがとうございます！"
}

// モックアドバイス生成
function generateMockAdvice(meal: any): string {
  const vegScore = meal.veg_score || 0
  const mode = meal.mode || 'cook'
  
  if (vegScore < 3) {
    return "野菜を少し増やすとさらにバランスが良くなりますよ。"
  }
  
  if (mode === 'out' || mode === 'buy') {
    return "次は自炊にチャレンジしてみませんか？"
  }
  
  return "この調子で続けていきましょう！"
}
