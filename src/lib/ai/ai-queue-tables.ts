/**
 * AI のキューの表 (#1465)。行を積むと、service role の処理が AI へ送る。
 * - weekly_menu_requests: Vercel Cron (process-menu-queue) が取り出し、generate-menu-v5 を呼ぶ
 * - meal_image_jobs: Edge Function process-meal-image-jobs が処理する
 *
 * 利用者 (authenticated) からは読むだけ (本人の行の SELECT。進み具合の表示と Realtime)。
 * INSERT / UPDATE / DELETE の権限とポリシーは migration 20261011010000_ai_queue_service_role_writes で外した。
 * 利用者が直接積んだ行は、AI の利用回数の記録 (#1177) と上限 (T40 #1149) をすり抜けるため。
 * 書くときは src/lib/ai/ai-queue-writer.ts の getAiQueueWriter (service role) を使う。
 *
 * (サーバー専用のモジュールを読み込まないので、テストからも読める)
 */
export const AI_QUEUE_TABLES = ['weekly_menu_requests', 'meal_image_jobs'] as const;
export type AiQueueTable = (typeof AI_QUEUE_TABLES)[number];
