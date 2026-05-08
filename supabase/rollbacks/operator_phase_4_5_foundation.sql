-- =====================================================
-- Rollback: operator_phase_4_5_foundation
-- Source: docs/design/operator/01-data-model.md §3.1〜§3.25 + §3.9.1
-- NOTE: Supabase CLI は _rollback サフィックスのファイルを自動 apply しない
-- 逆順 (FK 制約を考慮) で DROP
-- =====================================================

BEGIN;

-- =====================================================
-- §3.25 user_sessions_metadata
-- =====================================================
DROP TABLE IF EXISTS user_sessions_metadata CASCADE;

-- =====================================================
-- §3.24 failed_invite_lookups
-- =====================================================
DROP TABLE IF EXISTS failed_invite_lookups CASCADE;

-- =====================================================
-- §3.23 password_history
-- =====================================================
DROP TABLE IF EXISTS password_history CASCADE;

-- =====================================================
-- §3.21 gdpr_deletion_requests
-- =====================================================
DROP TABLE IF EXISTS gdpr_deletion_requests CASCADE;

-- =====================================================
-- §3.20 同意管理テーブル群
-- =====================================================
DROP TABLE IF EXISTS terms_acceptances CASCADE;
DROP TABLE IF EXISTS external_data_consents CASCADE;
DROP TABLE IF EXISTS cookie_consents CASCADE;

-- =====================================================
-- §3.19 email_delivery_logs / email_blacklist
-- =====================================================
DROP TABLE IF EXISTS email_blacklist CASCADE;
DROP TABLE IF EXISTS email_delivery_logs CASCADE;

-- =====================================================
-- §3.18 stripe_webhook_events
-- =====================================================
DROP TABLE IF EXISTS stripe_webhook_events CASCADE;

-- =====================================================
-- §3.17 help_articles
-- =====================================================
DROP TABLE IF EXISTS help_articles CASCADE;

-- =====================================================
-- §3.16 referral_rewards
-- =====================================================
DROP TABLE IF EXISTS referral_rewards CASCADE;

-- =====================================================
-- §3.15 daily_active_users
-- =====================================================
DROP TABLE IF EXISTS daily_active_users CASCADE;

-- =====================================================
-- §3.14 nps_surveys / csat_feedbacks
-- =====================================================
DROP TABLE IF EXISTS csat_feedbacks CASCADE;
DROP TABLE IF EXISTS nps_surveys CASCADE;

-- =====================================================
-- §3.13 experiments / experiment_assignments
-- =====================================================
DROP TABLE IF EXISTS experiment_assignments CASCADE;
DROP TABLE IF EXISTS experiments CASCADE;

-- =====================================================
-- §3.12 infra_metrics / infra_alerts
-- =====================================================
DROP TABLE IF EXISTS infra_alerts CASCADE;
DROP TABLE IF EXISTS infra_metrics CASCADE;

-- =====================================================
-- §3.11 sales_leads / sales_lead_activities
-- =====================================================
DROP TABLE IF EXISTS sales_lead_activities CASCADE;
DROP TABLE IF EXISTS sales_leads CASCADE;

-- =====================================================
-- §3.10 support_tickets / support_ticket_messages
-- =====================================================
DROP TABLE IF EXISTS support_ticket_messages CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;

-- =====================================================
-- §3.9.1 user_profiles 拡張の巻き戻し
-- =====================================================
ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS last_login_at,
  DROP COLUMN IF EXISTS plan_key_cached;

-- =====================================================
-- §3.9 admin_audit_logs 拡張列の巻き戻し
--   NOTE: 既存テーブル自体は削除しない (基本列は保持)
--   拡張列 (ADD COLUMN IF NOT EXISTS で追加した列) のみ DROP
-- =====================================================
ALTER TABLE admin_audit_logs
  DROP COLUMN IF EXISTS target_type,
  DROP COLUMN IF EXISTS severity,
  DROP COLUMN IF EXISTS impersonated_by,
  DROP COLUMN IF EXISTS session_id,
  DROP COLUMN IF EXISTS ip_address,
  DROP COLUMN IF EXISTS user_agent,
  DROP COLUMN IF EXISTS actor_email_snapshot,
  DROP COLUMN IF EXISTS actor_role_snapshot;

-- =====================================================
-- §3.8 revenue_snapshots
-- =====================================================
DROP TABLE IF EXISTS revenue_snapshots CASCADE;

-- =====================================================
-- §3.7 personal_subscriptions
-- =====================================================
DROP TABLE IF EXISTS personal_subscriptions CASCADE;

-- =====================================================
-- §3.6 coupon_redemptions
-- =====================================================
DROP TABLE IF EXISTS coupon_redemptions CASCADE;

-- =====================================================
-- §3.5 coupons
-- =====================================================
DROP TABLE IF EXISTS coupons CASCADE;

-- =====================================================
-- §3.4 plan_price_history
-- =====================================================
DROP TABLE IF EXISTS plan_price_history CASCADE;

-- =====================================================
-- §3.3 feature_packages
-- =====================================================
DROP TABLE IF EXISTS feature_packages CASCADE;

-- =====================================================
-- §3.2 subscription_plans (seed も含めて削除)
-- =====================================================
DROP TABLE IF EXISTS subscription_plans CASCADE;

COMMIT;
