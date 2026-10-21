-- rollback: 20261022120000_billing_iap_reconcile.sql
-- 先に vercel.json から /api/cron/iap-reconcile の行を外して Web のデプロイを戻すこと (新しい Web の cron の route はこの 2 つの関数を呼ぶ。
-- 関数だけ消すと GET /api/cron/iap-reconcile が毎時 500 になり、失敗の監視の通知が出続ける)。
-- 消えるもの: 関数 2 本・索引 1 本・印の表 iap_reconcile_attempts (候補の順番の印だけ。権利の行 personal_subscriptions は消さない・変えない)。
-- 戻したあとは、Webhook が届かなかった期限切れの購読が、本人の同期か遅延の再同期まで写らない (billing/03 Q-11 の状態に戻る)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として supabase/migrations に追加し、PR → main マージ → CI で適用する。
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.billing_iap_reconcile_mark_attempted(uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.billing_iap_reconcile_candidates(timestamptz, interval, integer);
DROP INDEX IF EXISTS public.idx_personal_subscriptions_iap_reconcile;
DROP TABLE IF EXISTS public.iap_reconcile_attempts;
