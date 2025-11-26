import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { mealId } = await request.json()

    if (!mealId) {
      return NextResponse.json({ error: 'mealId is required' }, { status: 400 })
    }

    // TODO: OpenAI GPTを使用してほめコメントを生成
    // 現在はプレースホルダー
    const feedback = {
      mealId,
      feedbackText: "素晴らしい食事ですね！バランスが取れています。",
      adviceText: "次回は野菜を少し増やすとさらに良いでしょう。",
      modelName: "gpt-4",
    }

    const { data, error } = await supabase
      .from('meal_ai_feedbacks')
      .insert(feedback)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ feedback: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}



