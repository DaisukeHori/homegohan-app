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
