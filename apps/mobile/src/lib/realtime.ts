import { supabase } from './supabase';

/**
 * weekly_menu_requests の UPDATE を購読する。
 * Realtime 接続が切れた場合に備え、5 秒ポーリング fallback も併用する。
 *
 * @param requestId  購読対象の weekly_menu_requests.id
 * @param onUpdate   行が UPDATE されるたびに呼ばれるコールバック (payload.new を渡す)
 * @returns          クリーンアップ関数 (unsubscribe + ポーリング停止)
 */
export function subscribeWeeklyMenuRequest(
  requestId: string,
  onUpdate: (row: Record<string, unknown>) => void,
): () => void {
  // --- Realtime subscription ---
  const channel = supabase
    .channel(`v4-${requestId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'weekly_menu_requests',
        filter: `id=eq.${requestId}`,
      },
      (payload: { new: Record<string, unknown> }) => onUpdate(payload.new),
    )
    .subscribe();

  // --- 5 秒ポーリング fallback ---
  const pollInterval = setInterval(() => {
    supabase
      .from('weekly_menu_requests')
      .select('*')
      .eq('id', requestId)
      .single()
      .then(({ data, error }: { data: Record<string, unknown> | null; error: unknown }) => {
        if (!error && data) {
          onUpdate(data);
        }
      })
      .catch(() => {
        // ポーリングエラーは無視 (Realtime 側が主系)
      });
  }, 5000);

  return () => {
    supabase.removeChannel(channel);
    clearInterval(pollInterval);
  };
}

/**
 * ai_nutrition_feedback の INSERT を購読する。
 * 5 秒ポーリング fallback も併用する。
 *
 * @param userId    購読対象の user_id
 * @param onInsert  行が INSERT されるたびに呼ばれるコールバック (payload.new を渡す)
 * @returns         クリーンアップ関数 (unsubscribe + ポーリング停止)
 */
export function subscribeNutritionFeedback(
  userId: string,
  onInsert: (row: Record<string, unknown>) => void,
): () => void {
  // --- Realtime subscription ---
  const channel = supabase
    .channel(`nutrition-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'ai_nutrition_feedback',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { new: Record<string, unknown> }) => onInsert(payload.new),
    )
    .subscribe();

  // 最後に確認した行数を記録してポーリング差分を検出
  let lastKnownCount = 0;
  let initialized = false;

  // --- 5 秒ポーリング fallback ---
  const pollInterval = setInterval(() => {
    supabase
      .from('ai_nutrition_feedback')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data, error }: { data: Record<string, unknown>[] | null; error: unknown }) => {
        if (!error && data && data.length > 0) {
          if (!initialized) {
            // 初回ポーリングはベースラインを記録するだけでコールバックを呼ばない
            lastKnownCount = data.length;
            initialized = true;
            return;
          }
          // 新規行が検出された場合のみコールバックを呼ぶ
          if (data.length > lastKnownCount) {
            lastKnownCount = data.length;
            onInsert(data[0]);
          }
        } else if (!initialized) {
          initialized = true;
        }
      })
      .catch(() => {
        // ポーリングエラーは無視 (Realtime 側が主系)
      });
  }, 5000);

  return () => {
    supabase.removeChannel(channel);
    clearInterval(pollInterval);
  };
}
