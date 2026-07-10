import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { restorePlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';

// スタックしているリクエストをクリーンアップ（5分以上前のpending/processingをfailedに）
export async function POST() {
  const supabase = await createClient();
  
  // 認証チェック
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // 自分のスタックしているリクエストを取得
  const { data: stuckRequests, error: fetchError } = await supabase
    .from('weekly_menu_requests')
    .select('id, status, created_at, generated_data')
    .eq('user_id', user.id)
    .in('status', ['queued', 'pending', 'processing'])
    .lt('created_at', fiveMinutesAgo);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!stuckRequests || stuckRequests.length === 0) {
    return NextResponse.json({ message: 'No stuck requests found', cleaned: 0 });
  }

  // スタックしているリクエストをfailedに更新
  const stuckIds = stuckRequests.map(r => r.id);
  const { error: updateError } = await supabase
    .from('weekly_menu_requests')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .in('id', stuckIds);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // #1042: waitUntil 消失等で生成コールバックが実行されず stuck になったリクエストについて、
  // 削除済み献立のスナップショットが残っていれば復元する（sweeper 経由の救済ロールバック）。
  let restoredMeals = 0;
  let skippedMeals = 0;
  let failedMeals = 0;
  for (const stuckRequest of stuckRequests) {
    const snapshot = extractPlannedMealsSnapshot((stuckRequest as { generated_data?: unknown }).generated_data);
    if (snapshot.length === 0) continue;
    const restoreResult = await restorePlannedMealsSnapshot(supabase, snapshot);
    restoredMeals += restoreResult.restored;
    skippedMeals += restoreResult.skipped;
    failedMeals += restoreResult.failed;
    console.log(
      `🔁 [stale sweeper/cleanup] Restored meals for request ${stuckRequest.id}: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
    );
  }

  return NextResponse.json({
    message: 'Cleaned up stuck requests',
    cleaned: stuckIds.length,
    ids: stuckIds,
    restoredMeals,
    skippedMeals,
    failedMeals,
  });
}

// GETでステータス確認
export async function GET() {
  const supabase = await createClient();
  
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: requests, error } = await supabase
    .from('weekly_menu_requests')
    .select('id, mode, status, created_at, updated_at')
    .eq('user_id', user.id)
    .in('status', ['queued', 'pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ 
    stuckRequests: requests,
    count: requests?.length ?? 0
  });
}
