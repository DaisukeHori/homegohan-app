-- rollback: 20261016237000_push_outbox.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する。
-- 先に worker の route (GET /api/cron/push-outbox) と vercel.json の行を戻すこと。表が無いと route の claim が失敗して 500 になる。
DROP TRIGGER IF EXISTS weekly_menu_requests_enqueue_push ON public.weekly_menu_requests;
DROP FUNCTION IF EXISTS public.enqueue_weekly_menu_result_push();
DROP FUNCTION IF EXISTS public.cleanup_push_outbox();
DROP FUNCTION IF EXISTS public.record_push_receipt(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.claim_push_receipts(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.defer_push_outbox(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.fail_push_outbox(uuid, text, text, text, integer, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.complete_push_outbox(uuid, text, text);
DROP FUNCTION IF EXISTS public.claim_push_outbox(text, integer, integer);
DROP FUNCTION IF EXISTS public.enqueue_push_notification(uuid, text, jsonb, text);
DROP TABLE IF EXISTS public.push_outbox;
-- 送信待ち・送信済みの記録は戻らない。user_push_tokens・weekly_menu_requests の行は変えていないので、そのまま
