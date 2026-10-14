-- supabase/baseline/replay_fixups.sql
-- #1116: 空の DB に migration を流したときに、本番と「表記まで」一致させるための作り直し。
--
-- 統合した migration (20251126124224_create_meal_planner_tables.sql) の末尾でだけ実行する。
-- ローカル / CI のスタックの組み立て (scripts/supabase-local.sh) には使わない。本番でも実行されない
-- (統合した version は本番で適用済みのため)。
--
-- 背景: pg_dump の出力 (prod_schema.sql) をそのまま流すと、意味は同じでも Postgres の保存形式が本番と
-- 変わるものがあり、CI の `supabase db diff --linked` が差分として出していた (PR #1281 の CI で 237 行)。
--   1. varchar 列の IN (...) を使う CHECK 制約・部分インデックス・ポリシー式
--      本番は `col IN ('a', 'b')` で作られ、`((col)::text = ANY ((ARRAY['a'::character varying, ...])::text[]))`
--      として保存されている。その表記を流し直すと、Postgres は配列のキャストを要素ごとのキャスト
--      (`ARRAY[('a'::character varying)::text, ...]`) として保存し直す。→ 本番と同じ `IN (...)` の形で作り直す。
--   2. ロールを 2 つ指定したポリシー
--      pg_dump がロールの並びを変える (本番 anon, authenticated → dump authenticated, anon)。→ 本番の並びで付け直す。
-- どちらも意味 (制約の条件・対象ロール) は変わらない。
--
-- 対象は PR #1281 の db diff に出た 35 件 (CHECK 制約 29・インデックス 1・ポリシー 5)。ローカルで本番の表記と
-- 一致することを確認済み。ベースラインを取り直しても、統合 (squash) はやり直さないため、このファイルも更新しない。

ALTER TABLE "public"."admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_severity_check";
ALTER TABLE "public"."admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_severity_check" CHECK (("severity" IN ('info', 'warn', 'critical')));
ALTER TABLE "public"."coupon_redemptions" DROP CONSTRAINT "coupon_redemptions_subscription_target_check";
ALTER TABLE "public"."coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_subscription_target_check" CHECK (("subscription_target" IN ('personal', 'org')));
ALTER TABLE "public"."coupons" DROP CONSTRAINT "coupons_applicable_to_check";
ALTER TABLE "public"."coupons" ADD CONSTRAINT "coupons_applicable_to_check" CHECK (("applicable_to" IN ('all', 'personal', 'family', 'org')));
ALTER TABLE "public"."coupons" DROP CONSTRAINT "coupons_discount_type_check";
ALTER TABLE "public"."coupons" ADD CONSTRAINT "coupons_discount_type_check" CHECK (("discount_type" IN ('fixed', 'percentage')));
ALTER TABLE "public"."coupons" DROP CONSTRAINT "coupons_status_check";
ALTER TABLE "public"."coupons" ADD CONSTRAINT "coupons_status_check" CHECK (("status" IN ('active', 'paused', 'expired')));
ALTER TABLE "public"."daily_active_users" DROP CONSTRAINT "daily_active_users_plan_type_check";
ALTER TABLE "public"."daily_active_users" ADD CONSTRAINT "daily_active_users_plan_type_check" CHECK (("plan_type" IN ('personal', 'family', 'org', 'all')));
ALTER TABLE "public"."email_blacklist" DROP CONSTRAINT "email_blacklist_reason_check";
ALTER TABLE "public"."email_blacklist" ADD CONSTRAINT "email_blacklist_reason_check" CHECK (("reason" IN ('bounce', 'complaint', 'manual')));
ALTER TABLE "public"."email_delivery_logs" DROP CONSTRAINT "email_delivery_logs_status_check";
ALTER TABLE "public"."email_delivery_logs" ADD CONSTRAINT "email_delivery_logs_status_check" CHECK (("status" IN ('sent', 'delivered', 'bounced', 'complained', 'opened', 'clicked')));
ALTER TABLE "public"."experiments" DROP CONSTRAINT "experiments_status_check";
ALTER TABLE "public"."experiments" ADD CONSTRAINT "experiments_status_check" CHECK (("status" IN ('draft', 'running', 'completed', 'cancelled')));
ALTER TABLE "public"."external_data_consents" DROP CONSTRAINT "external_data_consents_provider_check";
ALTER TABLE "public"."external_data_consents" ADD CONSTRAINT "external_data_consents_provider_check" CHECK (("provider" IN ('xai', 'anthropic', 'google', 'openai')));
ALTER TABLE "public"."failed_invite_lookups" DROP CONSTRAINT "failed_invite_lookups_invite_type_check";
ALTER TABLE "public"."failed_invite_lookups" ADD CONSTRAINT "failed_invite_lookups_invite_type_check" CHECK (("invite_type" IN ('family', 'org')));
ALTER TABLE "public"."feature_packages" DROP CONSTRAINT "feature_packages_status_check";
ALTER TABLE "public"."feature_packages" ADD CONSTRAINT "feature_packages_status_check" CHECK (("status" IN ('active', 'deprecated')));
ALTER TABLE "public"."help_articles" DROP CONSTRAINT "help_articles_status_check";
ALTER TABLE "public"."help_articles" ADD CONSTRAINT "help_articles_status_check" CHECK (("status" IN ('draft', 'published', 'archived')));
ALTER TABLE "public"."infra_alerts" DROP CONSTRAINT "infra_alerts_comparison_check";
ALTER TABLE "public"."infra_alerts" ADD CONSTRAINT "infra_alerts_comparison_check" CHECK (("comparison" IN ('>', '>=', '<', '<=', '=')));
ALTER TABLE "public"."infra_metrics" DROP CONSTRAINT "infra_metrics_source_check";
ALTER TABLE "public"."infra_metrics" ADD CONSTRAINT "infra_metrics_source_check" CHECK (("source" IN ('vercel', 'supabase', 'gemini', 'xai', 'anthropic', 'openai', 'custom')));
ALTER TABLE "public"."personal_subscriptions" DROP CONSTRAINT "personal_subscriptions_status_check";
ALTER TABLE "public"."personal_subscriptions" ADD CONSTRAINT "personal_subscriptions_status_check" CHECK (("status" IN ('trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace')));
ALTER TABLE "public"."plan_price_history" DROP CONSTRAINT "plan_price_history_applies_to_check";
ALTER TABLE "public"."plan_price_history" ADD CONSTRAINT "plan_price_history_applies_to_check" CHECK (("applies_to" IN ('new_only', 'on_renewal', 'immediately')));
ALTER TABLE "public"."referral_rewards" DROP CONSTRAINT "referral_rewards_reward_type_check";
ALTER TABLE "public"."referral_rewards" ADD CONSTRAINT "referral_rewards_reward_type_check" CHECK (("reward_type" IN ('credit', 'coupon', 'extension')));
ALTER TABLE "public"."referral_rewards" DROP CONSTRAINT "referral_rewards_status_check";
ALTER TABLE "public"."referral_rewards" ADD CONSTRAINT "referral_rewards_status_check" CHECK (("status" IN ('pending', 'granted', 'expired')));
ALTER TABLE "public"."sales_lead_activities" DROP CONSTRAINT "sales_lead_activities_activity_type_check";
ALTER TABLE "public"."sales_lead_activities" ADD CONSTRAINT "sales_lead_activities_activity_type_check" CHECK (("activity_type" IN ('call', 'email', 'meeting', 'note', 'stage_change')));
ALTER TABLE "public"."sales_leads" DROP CONSTRAINT "sales_leads_source_check";
ALTER TABLE "public"."sales_leads" ADD CONSTRAINT "sales_leads_source_check" CHECK (("source" IN ('website', 'referral', 'event', 'cold_call', 'other')));
ALTER TABLE "public"."sales_leads" DROP CONSTRAINT "sales_leads_stage_check";
ALTER TABLE "public"."sales_leads" ADD CONSTRAINT "sales_leads_stage_check" CHECK (("stage" IN ('approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost')));
ALTER TABLE "public"."stripe_webhook_events" DROP CONSTRAINT "stripe_webhook_events_processing_status_check";
ALTER TABLE "public"."stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_processing_status_check" CHECK (("processing_status" IN ('pending', 'processing', 'completed', 'failed')));
ALTER TABLE "public"."subscription_plans" DROP CONSTRAINT "subscription_plans_plan_type_check";
ALTER TABLE "public"."subscription_plans" ADD CONSTRAINT "subscription_plans_plan_type_check" CHECK (("plan_type" IN ('personal', 'family', 'org')));
ALTER TABLE "public"."subscription_plans" DROP CONSTRAINT "subscription_plans_status_check";
ALTER TABLE "public"."subscription_plans" ADD CONSTRAINT "subscription_plans_status_check" CHECK (("status" IN ('draft', 'public', 'private', 'deprecated')));
ALTER TABLE "public"."support_tickets" DROP CONSTRAINT "support_tickets_category_check";
ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_category_check" CHECK (("category" IN ('account', 'billing', 'feature', 'bug', 'other')));
ALTER TABLE "public"."support_tickets" DROP CONSTRAINT "support_tickets_priority_check";
ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_priority_check" CHECK (("priority" IN ('low', 'medium', 'high', 'urgent')));
ALTER TABLE "public"."support_tickets" DROP CONSTRAINT "support_tickets_status_check";
ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_status_check" CHECK (("status" IN ('open', 'in_progress', 'pending', 'resolved', 'closed')));
ALTER TABLE "public"."terms_acceptances" DROP CONSTRAINT "terms_acceptances_document_type_check";
ALTER TABLE "public"."terms_acceptances" ADD CONSTRAINT "terms_acceptances_document_type_check" CHECK (("document_type" IN ('terms_of_service', 'privacy_policy', 'parental_consent', 'external_data_provision')));
DROP INDEX "public"."idx_personal_subscriptions_active_per_user";
CREATE UNIQUE INDEX "idx_personal_subscriptions_active_per_user" ON "public"."personal_subscriptions" USING "btree" ("user_id") WHERE ("status" IN ('trialing', 'active', 'paused', 'past_due', 'grace'));
ALTER POLICY "catalog_products_select_all" ON "public"."catalog_products" TO "anon", "authenticated";
ALTER POLICY "catalog_source_categories_select_all" ON "public"."catalog_source_categories" TO "anon", "authenticated";
ALTER POLICY "catalog_sources_select_all" ON "public"."catalog_sources" TO "anon", "authenticated";
ALTER POLICY "Anyone can create inquiries" ON "public"."inquiries" TO "anon", "authenticated";
ALTER POLICY "subscription_plans_select_public" ON "public"."subscription_plans" USING ((("status" IN ('public', 'private')) OR (EXISTS ( SELECT 1 FROM "public"."user_profiles" WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));
