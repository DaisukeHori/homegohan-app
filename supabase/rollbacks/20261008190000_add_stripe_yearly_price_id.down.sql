-- rollback: 20261008190000_add_stripe_yearly_price_id.sql
-- 戻すと #1102 より前の状態 (Stripe Price ID を stripe_price_id の 1 列しか持てない状態) に戻る。
--
-- 内容: 足した列 stripe_yearly_price_id を消し、stripe_price_id の列コメントを外す
--       (この migration の前、stripe_price_id に列コメントは無かった)。
--       ほかの列・RLS ポリシー・GRANT には触れない。
-- データへの影響: stripe_yearly_price_id に書かれていた年額の Stripe Price ID は、列と一緒に失われる。
--       Stripe 側の Price は消えない (Stripe の Dashboard で Product の Price 一覧から確認できる。
--       作った Price には metadata の plan_key / changed_by / reason が付いている)。
-- 注意: 価格変更 API (POST /api/super-admin/plans/[id]/price-change) と Edge Function stripe-price-sync は、
--       年額の Price を作ると stripe_yearly_price_id へ書く / 読む。列を消すだけ戻すと、Stripe 同期が有効な環境では
--       価格変更が失敗する (本番は Stripe のキーが未設定のため影響しない。#1113)。
--       DB を戻すときは、その PR のコードも一緒に戻すこと。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.subscription_plans
  DROP COLUMN IF EXISTS stripe_yearly_price_id;

COMMENT ON COLUMN public.subscription_plans.stripe_price_id IS NULL;
