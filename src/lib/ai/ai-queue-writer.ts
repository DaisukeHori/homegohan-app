import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';

/**
 * AI のキュー (src/lib/ai/ai-queue-tables.ts の AI_QUEUE_TABLES: weekly_menu_requests / meal_image_jobs) へ書くためのクライアント (service role)。
 * 2 つの表は利用者 (authenticated) から書けない (#1465。migration 20261011010000_ai_queue_service_role_writes)。
 *
 * route は、本人の確認 (supabase.auth.getUser) と、同意 (#1154)・記録 (#1177) を通したあとで、これを使って書く。
 * RLS が効かないので、次を必ず守る:
 * - INSERT の user_id は、認証済みの user.id にする
 * - UPDATE は .eq('user_id', user.id) で本人の行に絞る (行の id が、この route がいま作ったものである場合を除く)
 *
 * 書き込みの受け手は、変数名 queueDb で受ける (tests/ai-queue-writes-contract.test.ts が、
 * キューへの書き込みが queueDb からだけであることを、ソースから確かめる)。
 */
export function getAiQueueWriter(): SupabaseClient {
  return getSupabaseAdmin();
}
