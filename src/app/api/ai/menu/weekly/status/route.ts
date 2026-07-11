import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { restorePlannedMealsSnapshot, extractPlannedMealsSnapshot } from '@/lib/planned-meals-snapshot';

// リクエストのステータスを確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');
  const now = new Date();
  const staleMinutes = 20;
  const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000);

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    // #1042: 通常ポーリング（3秒間隔）では生成中に肥大化する generated_data(jsonb) を
    // select しない。stale 判定が成立した場合のみ、下記で二次クエリして取得する。
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, error_message, updated_at, mode, start_date, target_meal_id, progress')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw error;

    if (!request) {
      return NextResponse.json({
        status: 'not_found',
        requestId,
      });
    }

    const updatedAt = request.updated_at ? new Date(request.updated_at) : null;
    // queued は cron が 1 分ごとに処理するため stale 判定から除外する
    const isStale = (request.status === 'pending' || request.status === 'processing')
      && updatedAt
      && updatedAt < staleBefore;
    if (isStale) {
      // stale リクエストを failed に更新
      const { error: staleError } = await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: 'stale_request_timeout',
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('user_id', user.id);
      if (staleError) {
        console.error('Failed to mark stale request as failed:', staleError);
      }

      // プレースホルダーは使用しないので、is_generating のクリアは不要

      // #1042: waitUntil 消失等で生成コールバックが実行されず stale になったケースでも、
      // 削除済み献立のスナップショットが残っていれば復元する（sweeper 経由の救済ロールバック）。
      // generated_data は stale 判定成立時のみここで二次クエリして取得する。
      const { data: snapshotRow, error: snapshotError } = await supabase
        .from('weekly_menu_requests')
        .select('generated_data')
        .eq('id', requestId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (snapshotError) {
        console.error('Failed to fetch generated_data for stale restore:', snapshotError);
      }
      const snapshot = extractPlannedMealsSnapshot(snapshotRow?.generated_data);
      let restoreResult: { restored: number; skipped: number; failed: number } | null = null;
      if (snapshot.length > 0) {
        restoreResult = await restorePlannedMealsSnapshot(supabase, snapshot);
        console.log(
          `🔁 [stale sweeper/status] Restored meals for request ${requestId}: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
        );
      }

      return NextResponse.json({
        status: 'failed',
        errorMessage: 'stale_request_timeout',
        updatedAt: new Date().toISOString(),
        ...(restoreResult ? { restore: restoreResult } : {}),
      });
    }

    return NextResponse.json({
      status: request.status,
      errorMessage: request.error_message,
      error_message: request.error_message,
      updatedAt: request.updated_at,
      progress: request.progress,
    });

  } catch (error: any) {
    console.error('Status check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// UX2-11: AI 生成の中止。weekly_menu_requests.status の CHECK 制約に 'cancelled' は
// 存在しない（migration 追加は本 Issue のスコープ外のため報告のみ）。既存の 'failed' + 判別可能な
// error_message で「ユーザーによる中止」を表現する。既に completed/failed の場合は上書きしない。
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { requestId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { requestId } = body;
  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('weekly_menu_requests')
      .select('id, status')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // 既に確定済み（completed/failed）の場合は上書きしない
    if (existing.status === 'completed' || existing.status === 'failed') {
      return NextResponse.json({ status: existing.status, cancelled: false });
    }

    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'failed',
        error_message: '中止しました',
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .eq('user_id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({ status: 'failed', cancelled: true });
  } catch (error: any) {
    console.error('Cancel request error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
