import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

/**
 * POST /api/ai/hint
 *
 * 週間献立ページ (統計モーダル) の「週間AIヒント」に出す一言を返す。
 *
 * #1327: 以前は Edge Function generate-hint (中で AI を呼ぶ) を呼んでいたが、戻り値は使わず、
 * このルートはいつも下の getDefaultHint() の結果を返していた (Edge Function が結果を保存する
 * user_hints テーブルも本番に無い)。週間献立ページを開くたびに AI を呼んで結果を捨てる費用の無駄
 * だったため、Edge Function は呼ばず、自炊率・平均カロリー・期限間近の食材から決まる定型のヒントだけを返す。
 * 呼び出し元 (menus/weekly/page.tsx の fetchAiHint) とレスポンスの形 ({ hint }) は変えていない。
 *
 * AI を呼ばないので、写真解析などと共有する 'analysis' のレート制限は使わない
 * (使うと、ページを開くたびにその枠を消費し、写真解析が 429 になりうる)。
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { cookRate, avgCal, expiringItems } = requestBody;

    return NextResponse.json({
      hint: getDefaultHint(cookRate, avgCal, expiringItems),
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

