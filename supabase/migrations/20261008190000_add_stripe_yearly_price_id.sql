-- migration: 20261008190000_add_stripe_yearly_price_id.sql
-- #1102: subscription_plans に、年額用の Stripe Price ID を入れる欄 stripe_yearly_price_id を足す
--        (stripe_price_id は「月額」の Price ID と決め、列コメントに残す)
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql の subscription_plans):
--   subscription_plans は Stripe Price ID を stripe_price_id の 1 列しか持てない。
--   Stripe の Price は「月額」と「年額」で別のオブジェクトなので、
--     - 月額と年額を同時に Stripe へ同期できない (価格変更 API は、両方を変えるリクエストを 422 で断っていた)
--     - この 1 列は「最後に触った側の Price」を指す意味になり、もう片方の Price への参照が DB から失われる
--   という問題があった (価格変更 API の旧コメント #1041 round-3 (C2) / round-4 (C) が、列の追加を「別途 migration」としていた)。
--   オーナー判断 (2026-10-08, #1102): 価格変更は新規契約だけに適用し、年額用の Stripe 価格 ID の欄を追加する。
--
-- 変更: subscription_plans に stripe_yearly_price_id を 1 列足す。
--     stripe_yearly_price_id  character varying(255)  NULL 可・既定値なし  (stripe_price_id と同じ型)
--   あわせて列コメントで、2 つの列の意味を決める。
--     stripe_price_id         月額の Stripe Price ID
--     stripe_yearly_price_id  年額の Stripe Price ID
--   次は変更しない: 既存の列、RLS ポリシー、GRANT、索引、関数、plan_price_history。
--
-- 本番のデータへの影響:
--   既存の行は stripe_yearly_price_id = NULL になる (データの書き換えは無い。UPDATE / DELETE は流さない)。
--   2026-10-06 のベースライン時点で、本番の subscription_plans は stripe_product_id / stripe_price_id がすべて NULL
--   (Stripe のキーが未設定で、Stripe への同期がまだ一度も動いていないため。#1113)。
--   つまり、旧仕様の「最後に触った側の Price」という意味で stripe_price_id に入っていた値は、本番には無い。
--   ローカルなど別の環境で、stripe_price_id に年額の Price が入っている行があっても、この migration はその値を動かさない。
--   次に月額を変えたとき、価格変更 API は stripe_price_id を新しい月額の Price に置き換える
--   (旧い年額の Price は、月額ではないと Stripe で確認できるため無効化されず、Stripe 上に残る)。
--   RLS: 新しい列も、ほかの列と同じ行の権限になる。
--     公開 / 非公開のプランの行は誰でも SELECT できる (Stripe の Price ID は秘密情報ではない。stripe_price_id と同じ)。
--     書き込みは super_admin だけ (subscription_plans_mutate_super_admin。今回は変えない)。
--
-- ロック: ADD COLUMN は subscription_plans の ACCESS EXCLUSIVE ロックを一瞬取る (NULL 許可・既定値なしの列は、行を書き換えない)。
--   長いトランザクションが残っていると、後ろに続く問い合わせまで待たせてしまうため、10 秒でロック待ちを諦める
--   (SET LOCAL は migration のトランザクション内だけ有効。取れなかった場合は migration が失敗するので、時間をおいて再実行する)。
--
-- 冪等: ADD COLUMN IF NOT EXISTS と COMMENT ON のため、2 回続けて適用してもエラーにならず、書いた値も消えない。
-- 確認: tests/integration/rls/subscription-plans-yearly-price-id.test.ts。この migration の前は列が無いため失敗し、
--   この migration の後は全件成功する (権限・冪等性も確かめる)。
-- ロールバック: supabase/rollbacks/20261008190000_add_stripe_yearly_price_id.down.sql
--   (列を落とすと、記録済みの年額の Price ID は失われる。価格変更 API のコードも一緒に戻すこと)

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS stripe_yearly_price_id character varying(255);

COMMENT ON COLUMN public.subscription_plans.stripe_price_id IS
  '月額の Stripe Price ID (年額は stripe_yearly_price_id)。価格変更 API / Edge Function stripe-price-sync が、月額を変えたときに新しい Price の ID へ更新する。';

COMMENT ON COLUMN public.subscription_plans.stripe_yearly_price_id IS
  '年額の Stripe Price ID (月額は stripe_price_id)。価格変更 API / Edge Function stripe-price-sync が、年額を変えたときに新しい Price の ID へ更新する。';
