import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { cookRate, avgCal, cookCount, buyCount, outCount, expiringItems } = await request.json();

    // Call Supabase Edge Function for AI hint generation (async)
    const { error: invokeError } = await supabase.functions.invoke('generate-hint', {
      body: {
        userId: user.id,
        cookRate,
        avgCal,
        cookCount,
        buyCount,
        outCount,
        expiringItems
      },
    });

    if (invokeError) {
      // If Edge Function fails, return a default hint
      console.error('Hint generation error:', invokeError);
      return NextResponse.json({ 
        hint: getDefaultHint(cookRate, avgCal, expiringItems) 
      });
    }

    // For now, return a smart default hint while the async process runs
    // In a full implementation, you'd store and retrieve the hint
    return NextResponse.json({ 
      hint: getDefaultHint(cookRate, avgCal, expiringItems) 
    });
  } catch (error: any) {
    console.error('AI Hint API Error:', error);
    return NextResponse.json({ 
      hint: '今週も健康的な食事を心がけましょう！' 
    });
  }
}

function getDefaultHint(cookRate: number, avgCal: number, expiringItems: string[]): string {
  const hints: string[] = [];

  // Cook rate based hints
  if (cookRate >= 80) {
    hints.push('自炊率80%以上！素晴らしいですね。栄養バランスも良好です。');
  } else if (cookRate >= 60) {
    hints.push(`自炊率${cookRate}%、いい調子です！週末に作り置きすると平日がもっと楽になりますよ。`);
  } else if (cookRate >= 40) {
    hints.push(`自炊率${cookRate}%です。簡単な時短レシピを増やしてみませんか？`);
  } else {
    hints.push(`自炊率${cookRate}%です。まずは週に2〜3回の自炊から始めてみましょう！`);
  }

  // Calorie based hints
  if (avgCal > 2500) {
    hints.push('カロリーが少し高めです。野菜を増やしてバランスを取りましょう。');
  } else if (avgCal < 1200 && avgCal > 0) {
    hints.push('カロリーが低めです。しっかり食べて栄養を取りましょう。');
  }

  // Expiring items hints
  if (expiringItems && expiringItems.length > 0) {
    const items = expiringItems.slice(0, 3).join('、');
    hints.push(`${items}が期限間近です。今週の献立に取り入れましょう！`);
  }

  return hints[Math.floor(Math.random() * hints.length)] || '今週も健康的な食事を心がけましょう！';
}

