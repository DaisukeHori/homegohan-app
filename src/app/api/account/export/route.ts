import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/db-logger';

/**
 * GDPR データポータビリティ用: 自分のデータを JSON でダウンロード。
 * 関連テーブルから user_id で引き、1ファイルにまとめて Content-Disposition で返す。
 *
 * テーブル一覧は user_id 列を持つ主要なものに限定。サブクエリで紐づく
 * ai_consultation_messages / shopping_list_items / planned_meals は親テーブル経由で含める。
 *
 * 各テーブル取得を safeQuery で個別に wrap しているため、
 * 1つのテーブルが失敗しても他のテーブルは取得を続ける。
 */

type QueryResult = unknown[] | { error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeQuery(label: string, queryFn: () => PromiseLike<{ data: any; error: any }>): Promise<QueryResult> {
  try {
    const { data, error } = await queryFn();
    if (error) {
      console.warn(`[export] ${label} error:`, error.message);
      return { error: error.message as string };
    }
    return (data as unknown[]) ?? [];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[export] ${label} exception:`, msg);
    return { error: msg };
  }
}

export async function GET() {
  const supabase = await createClient();
  let _userId: string | undefined;
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = user.id;
    _userId = userId;

    const exported: Record<string, unknown> = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      user: { id: userId, email: user.email },
    };

    // user_profiles: PK は id (= user_id), user_id 列は存在しない
    exported.user_profiles = await safeQuery('user_profiles', () =>
      supabase.from('user_profiles').select('*').eq('id', userId),
    );

    // user_id 直リンクのテーブル群
    exported.nutrition_targets = await safeQuery('nutrition_targets', () =>
      supabase.from('nutrition_targets').select('*').eq('user_id', userId),
    );

    exported.meals = await safeQuery('meals', () =>
      supabase.from('meals').select('*').eq('user_id', userId),
    );

    exported.weekly_menu_requests = await safeQuery('weekly_menu_requests', () =>
      supabase.from('weekly_menu_requests').select('*').eq('user_id', userId),
    );

    exported.health_records = await safeQuery('health_records', () =>
      supabase.from('health_records').select('*').eq('user_id', userId),
    );

    exported.health_goals = await safeQuery('health_goals', () =>
      supabase.from('health_goals').select('*').eq('user_id', userId),
    );

    // health_checkups: migration 20260111000000 で作成済み。
    // #61 のテーブル新設後に有効化予定だったが、すでに存在するため含める。
    exported.health_checkups = await safeQuery('health_checkups', () =>
      supabase.from('health_checkups').select('*').eq('user_id', userId),
    );

    exported.recipes = await safeQuery('recipes', () =>
      supabase.from('recipes').select('*').eq('user_id', userId),
    );

    // recipe_likes: migration 20260430000001 で作成済み
    exported.recipe_likes = await safeQuery('recipe_likes', () =>
      supabase.from('recipe_likes').select('*').eq('user_id', userId),
    );

    // pantry_items: 旧 fridge_items は存在しない。実テーブル名は pantry_items
    exported.pantry_items = await safeQuery('pantry_items', () =>
      supabase.from('pantry_items').select('*').eq('user_id', userId),
    );

    // user_badges: 旧 badges_user は存在しない。実テーブル名は user_badges
    exported.user_badges = await safeQuery('user_badges', () =>
      supabase.from('user_badges').select('*').eq('user_id', userId),
    );

    exported.ai_consultation_sessions = await safeQuery('ai_consultation_sessions', () =>
      supabase.from('ai_consultation_sessions').select('*').eq('user_id', userId),
    );

    // shopping_lists: user_id 直リンク
    exported.shopping_lists = await safeQuery('shopping_lists', () =>
      supabase.from('shopping_lists').select('*').eq('user_id', userId),
    );

    // ---------------------------------------------------------------------------
    // 子テーブル: 親テーブルの ID 経由で取得
    // ---------------------------------------------------------------------------

    // ai_consultation_messages: session_id 経由
    const sessions = exported.ai_consultation_sessions;
    if (Array.isArray(sessions) && sessions.length > 0) {
      const sessionIds = (sessions as { id: string }[]).map((s) => s.id).filter(Boolean);
      if (sessionIds.length > 0) {
        exported.ai_consultation_messages = await safeQuery('ai_consultation_messages', () =>
          supabase.from('ai_consultation_messages').select('*').in('session_id', sessionIds),
        );
      } else {
        exported.ai_consultation_messages = [];
      }
    } else {
      exported.ai_consultation_messages = [];
    }

    // shopping_list_items: shopping_list_id 経由
    const shoppingLists = exported.shopping_lists;
    if (Array.isArray(shoppingLists) && shoppingLists.length > 0) {
      const listIds = (shoppingLists as { id: string }[]).map((l) => l.id).filter(Boolean);
      if (listIds.length > 0) {
        exported.shopping_list_items = await safeQuery('shopping_list_items', () =>
          supabase.from('shopping_list_items').select('*').in('shopping_list_id', listIds),
        );
      } else {
        exported.shopping_list_items = [];
      }
    } else {
      exported.shopping_list_items = [];
    }

    // planned_meals: meal_plan_day_id -> meal_plan_days -> meal_plans (user_id) 経由
    // まず meal_plans を取得し、その meal_plan_days の id を使って planned_meals を取得
    const mealPlansResult = await safeQuery('meal_plans', () =>
      supabase.from('meal_plans').select('id').eq('user_id', userId),
    );
    exported.meal_plans = mealPlansResult;

    if (Array.isArray(mealPlansResult) && mealPlansResult.length > 0) {
      const mealPlanIds = (mealPlansResult as { id: string }[]).map((p) => p.id).filter(Boolean);

      const mealPlanDaysResult = await safeQuery('meal_plan_days', () =>
        supabase.from('meal_plan_days').select('id').in('meal_plan_id', mealPlanIds),
      );
      exported.meal_plan_days = mealPlanDaysResult;

      if (Array.isArray(mealPlanDaysResult) && mealPlanDaysResult.length > 0) {
        const dayIds = (mealPlanDaysResult as { id: string }[]).map((d) => d.id).filter(Boolean);
        exported.planned_meals = await safeQuery('planned_meals', () =>
          supabase.from('planned_meals').select('*').in('meal_plan_day_id', dayIds),
        );
      } else {
        exported.planned_meals = [];
      }
    } else {
      exported.meal_plan_days = [];
      exported.planned_meals = [];
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
  } catch (error: unknown) {
    console.error('Account export error:', error);
    const logger = _userId
      ? createLogger('api/account/export').withUser(_userId)
      : createLogger('api/account/export');
    logger.error('アカウントデータエクスポートでエラーが発生しました', error);
    const msg = error instanceof Error ? error.message : 'Export failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
