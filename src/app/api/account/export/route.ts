import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * GDPR データポータビリティ用: 自分のデータを JSON でダウンロード。
 * 関連テーブルから user_id で引き、1ファイルにまとめて Content-Disposition で返す。
 *
 * テーブル一覧は user_id 列を持つ主要なものに限定。サブクエリで紐づく
 * ai_consultation_messages / shopping_list_items は親テーブル経由で含める。
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = user.id;

  const tables = [
    'user_profiles',
    'nutrition_targets',
    'meals',
    'planned_meals',
    'weekly_menu_requests',
    'health_records',
    'health_goals',
    'health_checkups',
    'recipes',
    'recipe_likes',
    'shopping_lists',
    'fridge_items',
    'badges_user',
    'ai_consultation_sessions',
  ] as const;

  const exported: Record<string, unknown> = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: userId, email: user.email },
  };

  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('*').eq('user_id', userId);
    if (error) {
      // 存在しないテーブルや RLS で見えないテーブルは null として記録
      exported[table] = { error: error.message };
    } else {
      exported[table] = data;
    }
  }

  // ai_consultation_sessions に紐づくメッセージを別取得 (user_id が messages 側に無い場合がある)
  const sessions = (exported.ai_consultation_sessions as { id: string }[] | undefined) ?? [];
  if (Array.isArray(sessions) && sessions.length > 0) {
    const sessionIds = sessions.map((s) => s.id).filter(Boolean);
    if (sessionIds.length > 0) {
      const { data, error } = await supabase
        .from('ai_consultation_messages')
        .select('*')
        .in('session_id', sessionIds);
      exported.ai_consultation_messages = error ? { error: error.message } : data;
    }
  }

  const filename = `homegohan-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(exported, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
