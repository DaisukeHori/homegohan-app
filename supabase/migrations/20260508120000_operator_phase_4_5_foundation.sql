-- =====================================================
-- Migration: operator_phase_4_5_foundation
-- Source: docs/design/operator/01-data-model.md §3.1〜§3.25 + §3.9.1
-- Phase: operator 基盤-B (29 テーブル + 9 plan_key seed)
-- Idempotent: yes (IF NOT EXISTS / ON CONFLICT)
-- =====================================================

BEGIN;

-- =====================================================
-- §3.2  subscription_plans — プラン定義マスター
-- =====================================================

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key                VARCHAR(100) NOT NULL UNIQUE,
  display_name            VARCHAR(200) NOT NULL,
  plan_type               VARCHAR(20) NOT NULL
    CHECK (plan_type IN ('personal', 'family', 'org')),
  description             TEXT,
  -- 価格
  monthly_price_jpy       INT,            -- NULL = 無料 or カスタム
  yearly_price_jpy        INT,
  currency                VARCHAR(3) NOT NULL DEFAULT 'JPY',
  -- Stripe 連携
  stripe_product_id       VARCHAR(255),   -- Stripe Product object ID
  stripe_price_id         VARCHAR(255),   -- 現在有効な Stripe Price ID
  -- 上限値
  max_members             INT,            -- 家族最大人数、組織最大 seat 数
  max_family_seats        INT,            -- 組織プランの家族同梱 seat 数
  -- 機能
  feature_packages        UUID[] NOT NULL DEFAULT '{}',  -- feature_packages.id 配列
  -- 公開ステータス
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'public', 'private', 'deprecated')),
  display_order           INT NOT NULL DEFAULT 0,
  -- メタ
  banner_url              TEXT,
  trial_days              INT NOT NULL DEFAULT 0,
  min_contract_months     INT NOT NULL DEFAULT 1,
  auto_renew_default      BOOLEAN NOT NULL DEFAULT TRUE,
  -- deprecated 状態管理
  ends_at                 TIMESTAMPTZ,    -- プランの提供終了日 (deprecated プランのみ設定)
                                          -- NULL = 提供継続中 or 未設定
  -- バージョン管理
  version                 INT NOT NULL DEFAULT 1,
  superseded_by_plan_id   UUID REFERENCES subscription_plans(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_status ON subscription_plans(status, display_order);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_type ON subscription_plans(plan_type, status);

-- RLS
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

-- SELECT: 全認証ユーザー + 匿名 (公開プランのみ)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'subscription_plans' AND policyname = 'subscription_plans_select_public'
  ) THEN
    CREATE POLICY "subscription_plans_select_public" ON subscription_plans
      FOR SELECT USING (
        status IN ('public', 'private')
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- INSERT / UPDATE / DELETE: super_admin のみ
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'subscription_plans' AND policyname = 'subscription_plans_mutate_super_admin'
  ) THEN
    CREATE POLICY "subscription_plans_mutate_super_admin" ON subscription_plans
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
        )
      );
  END IF;
END $$;

COMMENT ON TABLE subscription_plans IS 'プラン定義マスター。全ドメインの plan_key FK 起点。';

-- =====================================================
-- §3.2 9種公式 plan_key seed
-- =====================================================

INSERT INTO subscription_plans
  (plan_key, display_name, plan_type, monthly_price_jpy, yearly_price_jpy,
   max_members, trial_days, status, display_order)
VALUES
  ('free',           'Free',            'personal', 0,     0,      NULL, 0, 'public', 10),
  ('pro',            'Pro',             'personal', 980,   9800,   NULL, 7, 'public', 20),
  ('family_basic',   'Family Basic',    'family',   1480,  14800,  4,    7, 'public', 30),
  ('family_pro',     'Family Pro',      'family',   2480,  24800,  8,    7, 'public', 40),
  ('family_addon',   'Family Addon',    'family',   280,   NULL,   NULL, 0, 'private', 50),
  ('org_starter',    'Org Starter',     'org',      580,   5800,   30,   0, 'public', 60),
  ('org_standard',   'Org Standard',    'org',      980,   9800,   100,  0, 'public', 70),
  ('org_pro',        'Org Pro',         'org',      1980,  19800,  500,  0, 'public', 80),
  ('org_enterprise', 'Org Enterprise',  'org',      NULL,  NULL,   NULL, 0, 'public', 90)
ON CONFLICT (plan_key) DO NOTHING;

-- =====================================================
-- §3.3  feature_packages — 機能パッケージ
-- =====================================================

CREATE TABLE IF NOT EXISTS feature_packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_key     VARCHAR(100) NOT NULL UNIQUE,
  display_name    VARCHAR(200) NOT NULL,
  description     TEXT,
  feature_flags   VARCHAR(100)[] NOT NULL DEFAULT '{}',
  display_order   INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deprecated')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE feature_packages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'feature_packages' AND policyname = 'feature_packages_select_authenticated'
  ) THEN
    CREATE POLICY "feature_packages_select_authenticated" ON feature_packages
      FOR SELECT TO authenticated USING (status = 'active');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'feature_packages' AND policyname = 'feature_packages_mutate_super_admin'
  ) THEN
    CREATE POLICY "feature_packages_mutate_super_admin" ON feature_packages
      FOR ALL USING (
        EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND 'super_admin' = ANY(roles))
      );
  END IF;
END $$;

COMMENT ON TABLE feature_packages IS '機能パッケージ定義。subscription_plans.feature_packages 配列から参照される。';

-- seed
INSERT INTO feature_packages (package_key, display_name, feature_flags, display_order) VALUES
  ('basic',             '基本機能',      ARRAY['meal_tracking','nutrition_view','health_record'], 10),
  ('ai_analysis',       'AI 解析',       ARRAY['food_recognition','ai_consultation','ai_menu_generate'], 20),
  ('family_management', '家族管理',      ARRAY['family_groups_enabled','shared_menu','shopping_list'], 30),
  ('family_8members',   '家族 8 名拡張', ARRAY['family_max_8_enabled'], 40),
  ('org_management',    '組織管理',      ARRAY['org_dashboard','license_management','challenge_feature'], 50),
  ('industrial_doctor', '産業医連携',    ARRAY['industrial_doctor_access','ai_doctor_advice','health_report_advanced'], 60),
  ('sso',               'SSO',           ARRAY['sso_saml_enabled','scim_enabled'], 70)
ON CONFLICT (package_key) DO NOTHING;

-- =====================================================
-- §3.4  plan_price_history — 価格変更履歴
-- =====================================================

CREATE TABLE IF NOT EXISTS plan_price_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  old_monthly_price_jpy INT,
  new_monthly_price_jpy INT,
  old_yearly_price_jpy  INT,
  new_yearly_price_jpy  INT,
  old_stripe_price_id   VARCHAR(255),
  new_stripe_price_id   VARCHAR(255),
  changed_by            UUID NOT NULL REFERENCES auth.users(id),
  reason                TEXT,
  effective_at          TIMESTAMPTZ NOT NULL,
  applies_to            VARCHAR(30) NOT NULL
    CHECK (applies_to IN ('new_only', 'on_renewal', 'immediately')),
  affected_subscription_count INT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_price_history_plan ON plan_price_history(plan_id, created_at DESC);

ALTER TABLE plan_price_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'plan_price_history' AND policyname = 'plan_price_history_select'
  ) THEN
    CREATE POLICY "plan_price_history_select" ON plan_price_history
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin','finance']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- UPDATE / DELETE 不可 (変更履歴は不可逆)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'plan_price_history' AND policyname = 'plan_price_history_no_update'
  ) THEN
    CREATE POLICY "plan_price_history_no_update" ON plan_price_history
      FOR UPDATE USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'plan_price_history' AND policyname = 'plan_price_history_no_delete'
  ) THEN
    CREATE POLICY "plan_price_history_no_delete" ON plan_price_history
      FOR DELETE USING (false);
  END IF;
END $$;

COMMENT ON TABLE plan_price_history IS 'プラン価格変更履歴。不可逆(UPDATE/DELETE 禁止)。';

-- =====================================================
-- §3.5  coupons — クーポン・割引コード
-- =====================================================

CREATE TABLE IF NOT EXISTS coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(50) NOT NULL UNIQUE,
  display_name      VARCHAR(200),
  discount_type     VARCHAR(20) NOT NULL CHECK (discount_type IN ('fixed', 'percentage')),
  discount_value    NUMERIC NOT NULL,
  applicable_plans  UUID[] NOT NULL DEFAULT '{}',
  applicable_to     VARCHAR(20) NOT NULL DEFAULT 'all'
    CHECK (applicable_to IN ('all', 'personal', 'family', 'org')),
  valid_from        TIMESTAMPTZ NOT NULL,
  valid_until       TIMESTAMPTZ NOT NULL,
  max_uses          INT,
  uses_count        INT NOT NULL DEFAULT 0,
  per_user_limit    INT NOT NULL DEFAULT 1,
  duration_months   INT,
  -- クーポン利益プレビュー (管理 UI 向け、DB 計算済)
  gross_margin_preview_jpy INT,
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'expired')),
  created_by        UUID NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT coupons_discount_value_positive CHECK (discount_value > 0),
  CONSTRAINT coupons_percentage_max CHECK (discount_type != 'percentage' OR discount_value <= 100)
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status, valid_until);

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_select_sales_or_above'
  ) THEN
    CREATE POLICY "coupons_select_sales_or_above" ON coupons
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['sales','finance','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupons' AND policyname = 'coupons_mutate_sales_or_above'
  ) THEN
    CREATE POLICY "coupons_mutate_sales_or_above" ON coupons
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['sales','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE coupons IS 'クーポン・割引コード管理。';

-- =====================================================
-- §3.6  coupon_redemptions — クーポン適用履歴
-- =====================================================

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id                   UUID NOT NULL REFERENCES coupons(id),
  user_id                     UUID REFERENCES auth.users(id),
  organization_id             UUID,
  -- NOTE: organizations テーブルは org/ ドメイン (02-organization-management) で作成される。
  -- coupon_redemptions が先行するため、FK は後続 migration で
  -- ALTER TABLE coupon_redemptions ADD CONSTRAINT ... REFERENCES organizations(id)
  -- として付与する (PG は CREATE TABLE 時に DEFERRABLE 単独指定不可、要 REFERENCES)。
  subscription_target         VARCHAR(20) NOT NULL
    CHECK (subscription_target IN ('personal', 'org')),
  applied_to_subscription_id  UUID NOT NULL,
  discount_amount_jpy         INT NOT NULL,
  duration_months             INT,
  redeemed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                    TIMESTAMPTZ,
  end_reason                  VARCHAR(50),
    -- 'replaced_by_other_coupon' / 'subscription_cancelled' / 'duration_expired'
  applied_retroactively       BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by                 UUID REFERENCES auth.users(id),
  CONSTRAINT coupon_redemptions_user_or_org CHECK (
    (user_id IS NOT NULL) OR (organization_id IS NOT NULL)
  )
);

-- 1 契約に対し有効な redemption は常に 1 件まで (重複適用不可)
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_active_per_subscription
  ON coupon_redemptions(subscription_target, applied_to_subscription_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id, redeemed_at DESC);

ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'coupon_redemptions' AND policyname = 'coupon_redemptions_select'
  ) THEN
    CREATE POLICY "coupon_redemptions_select" ON coupon_redemptions
      FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['finance','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE coupon_redemptions IS 'クーポン適用履歴。1契約に有効なredemptionは1件のみ。';

-- =====================================================
-- §3.7  personal_subscriptions — 個人課金
-- =====================================================

CREATE TABLE IF NOT EXISTS personal_subscriptions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_key                    VARCHAR(100) NOT NULL
    REFERENCES subscription_plans(plan_key)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  -- ステータス
  -- past_due → grace (7日経過) → cancelled (30日経過) の段階的遷移
  status                      VARCHAR(20) NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace')),
  -- 試用
  trial_started_at            TIMESTAMPTZ,
  trial_ends_at               TIMESTAMPTZ,
  trial_source                VARCHAR(50),
    -- 'direct' / 'referral' / 'campaign:xxx'
  -- 一時停止 (組織ライセンス受領時)
  paused_at                   TIMESTAMPTZ,
  paused_until                TIMESTAMPTZ,
  pause_reason                VARCHAR(50),
    -- 'org_license_received' / 'user_request'
  -- 期間
  starts_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_start        TIMESTAMPTZ,
  current_period_end          TIMESTAMPTZ,
  cancel_at                   TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  -- グレースペリオド (past_due → grace → cancelled 遷移)
  past_due_since              TIMESTAMPTZ,  -- status が past_due になった時刻
  grace_started_at            TIMESTAMPTZ,  -- status が grace になった時刻 (past_due から 7 日後)
  -- Stripe
  stripe_customer_id          VARCHAR(255),
  stripe_subscription_id      VARCHAR(255) UNIQUE,
  stripe_price_id             VARCHAR(255),
  -- クーポン
  active_coupon_redemption_id UUID REFERENCES coupon_redemptions(id),
  -- メタ
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ps_paused_until_required
    CHECK (NOT (status = 'paused' AND paused_until IS NULL))
);

-- 1 ユーザーに対し active/trialing/paused/past_due/grace は最大 1 件
-- (cancelled/expired は履歴として複数残せる)
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_subscriptions_active_per_user
  ON personal_subscriptions(user_id)
  WHERE status IN ('trialing', 'active', 'paused', 'past_due', 'grace');

CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_status
  ON personal_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_trial_ending
  ON personal_subscriptions(trial_ends_at)
  WHERE status = 'trialing';
CREATE INDEX IF NOT EXISTS idx_personal_subscriptions_stripe_sub
  ON personal_subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE personal_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT: 本人 or admin 系 or finance
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'personal_subscriptions' AND policyname = 'personal_subscriptions_select'
  ) THEN
    CREATE POLICY "personal_subscriptions_select" ON personal_subscriptions
      FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin','finance','support']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- INSERT: 本人 (Stripe Webhook 経由 service_role) or admin
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'personal_subscriptions' AND policyname = 'personal_subscriptions_insert'
  ) THEN
    CREATE POLICY "personal_subscriptions_insert" ON personal_subscriptions
      FOR INSERT WITH CHECK (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- UPDATE: 本人 (cancel/pause) or admin/super_admin
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'personal_subscriptions' AND policyname = 'personal_subscriptions_update'
  ) THEN
    CREATE POLICY "personal_subscriptions_update" ON personal_subscriptions
      FOR UPDATE USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- DELETE: 不可 (履歴保持)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'personal_subscriptions' AND policyname = 'personal_subscriptions_no_delete'
  ) THEN
    CREATE POLICY "personal_subscriptions_no_delete" ON personal_subscriptions
      FOR DELETE USING (false);
  END IF;
END $$;

COMMENT ON TABLE personal_subscriptions IS '個人課金サブスクリプション。plan_key は subscription_plans(plan_key) FK (ON UPDATE CASCADE / ON DELETE RESTRICT)。';

-- =====================================================
-- §3.8  revenue_snapshots — 収益日次スナップショット
-- =====================================================

CREATE TABLE IF NOT EXISTS revenue_snapshots (
  date                  DATE PRIMARY KEY,
  personal_active_users INT NOT NULL DEFAULT 0,
  personal_mrr_jpy      INT NOT NULL DEFAULT 0,
  family_active_groups  INT NOT NULL DEFAULT 0,
  family_mrr_jpy        INT NOT NULL DEFAULT 0,
  org_active_orgs       INT NOT NULL DEFAULT 0,
  org_active_seats      INT NOT NULL DEFAULT 0,
  org_mrr_jpy           INT NOT NULL DEFAULT 0,
  total_mrr_jpy         INT NOT NULL DEFAULT 0,
  total_arr_jpy         INT NOT NULL DEFAULT 0,
  new_signups           INT NOT NULL DEFAULT 0,
  cancellations         INT NOT NULL DEFAULT 0,
  upgrade_count         INT NOT NULL DEFAULT 0,
  downgrade_count       INT NOT NULL DEFAULT 0,
  trial_starts          INT NOT NULL DEFAULT 0,
  trial_conversions     INT NOT NULL DEFAULT 0,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE revenue_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'revenue_snapshots' AND policyname = 'revenue_snapshots_select'
  ) THEN
    CREATE POLICY "revenue_snapshots_select" ON revenue_snapshots
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['finance','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE revenue_snapshots IS '収益日次スナップショット。日次バッチで集計される。';

-- =====================================================
-- §3.9  admin_audit_logs — 監査ログ (不可逆)
--   既存テーブルが存在する場合は列追加のみ、存在しない場合は新規作成
-- =====================================================

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type VARCHAR(100) NOT NULL,
  target_id   UUID,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS target_type          VARCHAR(30),
  ADD COLUMN IF NOT EXISTS severity             VARCHAR(20) NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS impersonated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS session_id           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ip_address           INET,
  ADD COLUMN IF NOT EXISTS user_agent           TEXT,
  ADD COLUMN IF NOT EXISTS actor_email_snapshot VARCHAR(255),
  ADD COLUMN IF NOT EXISTS actor_role_snapshot  VARCHAR(50);

-- severity の CHECK 制約を追加(既存カラムの場合は既に存在する可能性あり)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'admin_audit_logs_severity_check'
      AND table_name = 'admin_audit_logs'
  ) THEN
    ALTER TABLE admin_audit_logs
      ADD CONSTRAINT admin_audit_logs_severity_check
      CHECK (severity IN ('info', 'warn', 'critical'));
  END IF;
END $$;

-- actor_id を NULL 許容に変更 (GDPR 削除対応) — 既存 NOT NULL 制約があれば解除
ALTER TABLE admin_audit_logs ALTER COLUMN actor_id DROP NOT NULL;

-- actor_id FK の再設定 (ON DELETE SET NULL)
ALTER TABLE admin_audit_logs
  DROP CONSTRAINT IF EXISTS admin_audit_logs_actor_id_fkey;
ALTER TABLE admin_audit_logs
  ADD CONSTRAINT admin_audit_logs_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- インデックス
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON admin_audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON admin_audit_logs(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON admin_audit_logs(severity, created_at DESC);

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: super_admin のみ
-- (admin が自分の操作を消せない設計 — admin にも閲覧権限を与えない)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'admin_audit_logs' AND policyname = 'audit_logs_select_super_admin'
  ) THEN
    CREATE POLICY "audit_logs_select_super_admin" ON admin_audit_logs
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
        )
      );
  END IF;
END $$;

-- INSERT: admin 系全ロールから可、actor_id = auth.uid() を強制
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'admin_audit_logs' AND policyname = 'audit_logs_insert_admins'
  ) THEN
    CREATE POLICY "audit_logs_insert_admins" ON admin_audit_logs
      FOR INSERT WITH CHECK (
        actor_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['admin','super_admin','support','sales','finance','content_moderator']::TEXT[]
                && roles
        )
      );
  END IF;
END $$;

-- UPDATE / DELETE: 完全禁止 (不可逆性の保証)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'admin_audit_logs' AND policyname = 'audit_logs_no_update'
  ) THEN
    CREATE POLICY "audit_logs_no_update" ON admin_audit_logs
      FOR UPDATE USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'admin_audit_logs' AND policyname = 'audit_logs_no_delete'
  ) THEN
    CREATE POLICY "audit_logs_no_delete" ON admin_audit_logs
      FOR DELETE USING (false);
  END IF;
END $$;

-- 7 年保管: 運用ポリシーで pg_cron による Cold Storage 移行を実施
COMMENT ON TABLE admin_audit_logs IS '監査ログ。RLS により UPDATE/DELETE 完全禁止。保持期間7年(個人情報保護法/SOC2)';

-- =====================================================
-- §3.9.1 user_profiles 拡張 (operator 連携用)
-- =====================================================

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS last_login_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plan_key_cached  VARCHAR(100);

COMMENT ON COLUMN user_profiles.last_login_at IS '最終ログイン日時 (auth.users.last_sign_in_at を Edge Function が同期)';
COMMENT ON COLUMN user_profiles.plan_key_cached IS 'personal_subscriptions の現在有効な plan_key キャッシュ (Edge Function が同期、常に最新とは限らない)';

-- =====================================================
-- §3.10 support_tickets / support_ticket_messages
-- =====================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  subject       VARCHAR(200) NOT NULL,
  category      VARCHAR(50) NOT NULL
    CHECK (category IN ('account','billing','feature','bug','other')),
  priority      VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status        VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'pending', 'resolved', 'closed')),
  assignee_id   UUID REFERENCES auth.users(id),
  -- SLA tracking
  first_response_at TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  -- 組織・家族関連付け (任意)
  -- organizations FK は org ドメイン migration で ALTER TABLE で付与
  organization_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES auth.users(id),
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  body        TEXT NOT NULL,
  attachments JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON support_ticket_messages(ticket_id, created_at ASC);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_messages ENABLE ROW LEVEL SECURITY;

-- tickets: 本人閲覧 + support/admin/super_admin
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'support_tickets' AND policyname = 'tickets_select'
  ) THEN
    CREATE POLICY "tickets_select" ON support_tickets
      FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['support','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'support_tickets' AND policyname = 'tickets_insert_user'
  ) THEN
    CREATE POLICY "tickets_insert_user" ON support_tickets
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'support_tickets' AND policyname = 'tickets_update_support'
  ) THEN
    CREATE POLICY "tickets_update_support" ON support_tickets
      FOR UPDATE USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['support','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

-- messages: 内部メモは support のみ閲覧
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'support_ticket_messages' AND policyname = 'ticket_messages_select'
  ) THEN
    CREATE POLICY "ticket_messages_select" ON support_ticket_messages
      FOR SELECT USING (
        NOT is_internal
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['support','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'support_ticket_messages' AND policyname = 'ticket_messages_insert'
  ) THEN
    CREATE POLICY "ticket_messages_insert" ON support_ticket_messages
      FOR INSERT WITH CHECK (sender_id = auth.uid());
  END IF;
END $$;

COMMENT ON TABLE support_tickets IS 'サポートチケット。SLA トラッキング対応。';
COMMENT ON TABLE support_ticket_messages IS 'サポートチケットメッセージ。is_internal=true は support ロールのみ閲覧。';

-- =====================================================
-- §3.11 sales_leads / sales_lead_activities
-- =====================================================

CREATE TABLE IF NOT EXISTS sales_leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    VARCHAR(200) NOT NULL,
  industry        VARCHAR(100),
  employee_count  INT,
  contact_name    VARCHAR(100),
  contact_email   VARCHAR(255),
  contact_phone   VARCHAR(50),
  source          VARCHAR(50)
    CHECK (source IN ('website','referral','event','cold_call','other')),
  stage           VARCHAR(30) NOT NULL DEFAULT 'approach'
    CHECK (stage IN ('approach','meeting','proposal','negotiation','won','lost')),
  assigned_to     UUID REFERENCES auth.users(id),
  estimated_acv   INT,
  notes           TEXT,
  -- 契約後の組織 ID (organizations FK は org ドメイン migration で ALTER TABLE で付与)
  converted_org_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_leads_stage ON sales_leads(stage, assigned_to);

CREATE TABLE IF NOT EXISTS sales_lead_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  actor_id        UUID NOT NULL REFERENCES auth.users(id),
  activity_type   VARCHAR(30) NOT NULL
    CHECK (activity_type IN ('call','email','meeting','note','stage_change')),
  details         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sales_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_lead_activities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sales_leads' AND policyname = 'sales_leads_access'
  ) THEN
    CREATE POLICY "sales_leads_access" ON sales_leads
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['sales','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sales_lead_activities' AND policyname = 'sales_activities_access'
  ) THEN
    CREATE POLICY "sales_activities_access" ON sales_lead_activities
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid()
            AND ARRAY['sales','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE sales_leads IS '法人見込み客(リード)管理。';
COMMENT ON TABLE sales_lead_activities IS '営業活動ログ。設計書別名: sales_activities。';

-- =====================================================
-- §3.12 infra_metrics / infra_alerts
-- =====================================================

CREATE TABLE IF NOT EXISTS infra_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name VARCHAR(100) NOT NULL,
  source      VARCHAR(50) NOT NULL
    CHECK (source IN ('vercel','supabase','gemini','xai','anthropic','openai','custom')),
  value       NUMERIC NOT NULL,
  unit        VARCHAR(20),
  tags        JSONB DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_metrics_recent ON infra_metrics(metric_name, recorded_at DESC);
-- 30 日以上古いデータは pg_cron で削除
CREATE INDEX IF NOT EXISTS idx_infra_metrics_cleanup ON infra_metrics(recorded_at);

CREATE TABLE IF NOT EXISTS infra_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name VARCHAR(100) NOT NULL,
  threshold   NUMERIC NOT NULL,
  comparison  VARCHAR(10) NOT NULL CHECK (comparison IN ('>','>=','<','<=','=')),
  triggered_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  details     JSONB,
  ack_by      UUID REFERENCES auth.users(id),
  ack_at      TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE infra_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra_alerts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'infra_metrics' AND policyname = 'infra_select_super_admin'
  ) THEN
    CREATE POLICY "infra_select_super_admin" ON infra_metrics
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND 'super_admin' = ANY(roles))
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'infra_alerts' AND policyname = 'infra_alerts_access'
  ) THEN
    CREATE POLICY "infra_alerts_access" ON infra_alerts
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE infra_metrics IS 'インフラメトリクス。30日超は pg_cron で削除。';
COMMENT ON TABLE infra_alerts IS 'インフラアラート。';

-- =====================================================
-- §3.13 experiments / experiment_assignments — A/B テスト
-- =====================================================

CREATE TABLE IF NOT EXISTS experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             VARCHAR(100) NOT NULL UNIQUE,
  name            VARCHAR(200) NOT NULL,
  hypothesis      TEXT,
  variants        JSONB NOT NULL,
    -- [{ key: 'control', weight: 50 }, { key: 'variant_a', weight: 50 }]
  primary_metric  VARCHAR(100),
  start_date      DATE,
  end_date        DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  result          JSONB,
  created_by      UUID NOT NULL REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  experiment_id UUID NOT NULL REFERENCES experiments(id),
  user_id       UUID NOT NULL REFERENCES auth.users(id),
  variant_key   VARCHAR(50) NOT NULL,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (experiment_id, user_id)
);

ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'experiments' AND policyname = 'experiments_select_super_admin'
  ) THEN
    CREATE POLICY "experiments_select_super_admin" ON experiments
      FOR ALL USING (
        EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND 'super_admin' = ANY(roles))
      );
  END IF;
END $$;

COMMENT ON TABLE experiments IS 'A/Bテスト実験定義。';
COMMENT ON TABLE experiment_assignments IS 'A/Bテストユーザー割り当て。';

-- =====================================================
-- §3.14 nps_surveys / csat_feedbacks
-- =====================================================

CREATE TABLE IF NOT EXISTS nps_surveys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  score       INT NOT NULL CHECK (score BETWEEN 0 AND 10),
  comment     TEXT,
  plan_key    VARCHAR(100),
  sent_at     TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nps_surveys_recent ON nps_surveys(sent_at DESC);

CREATE TABLE IF NOT EXISTS csat_feedbacks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  ticket_id   UUID REFERENCES support_tickets(id),
  score       INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE nps_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE csat_feedbacks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'nps_surveys' AND policyname = 'nps_select_admin'
  ) THEN
    CREATE POLICY "nps_select_admin" ON nps_surveys
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin','support']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'nps_surveys' AND policyname = 'nps_insert_self'
  ) THEN
    CREATE POLICY "nps_insert_self" ON nps_surveys
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'csat_feedbacks' AND policyname = 'csat_access'
  ) THEN
    CREATE POLICY "csat_access" ON csat_feedbacks
      FOR ALL USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['support','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE nps_surveys IS 'NPS アンケート。スコア 0-10。';
COMMENT ON TABLE csat_feedbacks IS 'CSAT フィードバック。スコア 1-5。サポートチケット紐付け。';

-- =====================================================
-- §3.15 daily_active_users
-- =====================================================

CREATE TABLE IF NOT EXISTS daily_active_users (
  date          DATE NOT NULL,
  plan_type     VARCHAR(20) NOT NULL CHECK (plan_type IN ('personal','family','org','all')),
  plan_key      VARCHAR(100) NOT NULL DEFAULT '',
  -- plan_key: 集計対象の plan_key。全体集計行は '' (空文字) を使用
  dau           INT NOT NULL DEFAULT 0,
  wau           INT NOT NULL DEFAULT 0,
  mau           INT NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, plan_type, plan_key)
  -- NOTE: PostgreSQL の PRIMARY KEY に COALESCE 等の関数式は使用不可。
  -- plan_key を NOT NULL DEFAULT '' に変更し、全体集計行は '' で代替する。
);

ALTER TABLE daily_active_users ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'daily_active_users' AND policyname = 'dau_select_admin'
  ) THEN
    CREATE POLICY "dau_select_admin" ON daily_active_users
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin','finance']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE daily_active_users IS '日次アクティブユーザー集計。全体集計行は plan_key=空文字。';

-- =====================================================
-- §3.16 referral_rewards
-- =====================================================

CREATE TABLE IF NOT EXISTS referral_rewards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES auth.users(id),
  referred_id     UUID NOT NULL REFERENCES auth.users(id),
  reward_type     VARCHAR(30) NOT NULL CHECK (reward_type IN ('credit','coupon','extension')),
  reward_value    JSONB NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','granted','expired')),
  granted_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE referral_rewards ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_rewards' AND policyname = 'referral_rewards_select'
  ) THEN
    CREATE POLICY "referral_rewards_select" ON referral_rewards
      FOR SELECT USING (
        referrer_id = auth.uid()
        OR referred_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE referral_rewards IS '紹介報酬。紹介者・被紹介者双方が自分のレコードを参照可能。';

-- =====================================================
-- §3.17 help_articles
-- =====================================================

CREATE TABLE IF NOT EXISTS help_articles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(200) NOT NULL UNIQUE,
  title       VARCHAR(500) NOT NULL,
  body        TEXT NOT NULL,
  category    VARCHAR(100),
  tags        VARCHAR(50)[] DEFAULT '{}',
  status      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  locale      VARCHAR(5) NOT NULL DEFAULT 'ja',
  view_count  INT NOT NULL DEFAULT 0,
  created_by  UUID NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE help_articles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'help_articles' AND policyname = 'help_articles_public'
  ) THEN
    CREATE POLICY "help_articles_public" ON help_articles
      FOR SELECT USING (status = 'published');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'help_articles' AND policyname = 'help_articles_manage'
  ) THEN
    CREATE POLICY "help_articles_manage" ON help_articles
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin','support']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE help_articles IS 'ヘルプ記事。published のみ一般公開。';

-- =====================================================
-- §3.18 stripe_webhook_events — Stripe Webhook 冪等化
-- =====================================================

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id              VARCHAR(255) PRIMARY KEY,  -- Stripe event.id (例: evt_1234)
  event_type      VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending','processing','completed','failed')),
  processed_at    TIMESTAMPTZ,
  error_message   TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_status ON stripe_webhook_events(processing_status, received_at);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- service_role のみアクセス (Webhook ハンドラは Edge Function 経由)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'stripe_webhook_events' AND policyname = 'stripe_webhook_no_access_rls'
  ) THEN
    CREATE POLICY "stripe_webhook_no_access_rls" ON stripe_webhook_events
      FOR ALL USING (false);
  END IF;
END $$;
-- Edge Function は service_role で bypass

COMMENT ON TABLE stripe_webhook_events IS 'Stripe Webhook 冪等化テーブル。PK = Stripe event.id。service_role のみアクセス。';

-- =====================================================
-- §3.19 email_delivery_logs / email_blacklist
-- =====================================================

CREATE TABLE IF NOT EXISTS email_delivery_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users(id),
  email           VARCHAR(255) NOT NULL,
  template        VARCHAR(100),
  resend_message_id VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'delivered', 'bounced', 'complained', 'opened', 'clicked')),
  metadata        JSONB DEFAULT '{}',
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_email ON email_delivery_logs(email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_user ON email_delivery_logs(user_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS email_blacklist (
  email         VARCHAR(255) PRIMARY KEY,
  reason        VARCHAR(50) NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      UUID REFERENCES auth.users(id)
);

ALTER TABLE email_delivery_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_blacklist ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_delivery_logs' AND policyname = 'email_logs_admin'
  ) THEN
    CREATE POLICY "email_logs_admin" ON email_delivery_logs
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['support','admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_blacklist' AND policyname = 'email_blacklist_admin'
  ) THEN
    CREATE POLICY "email_blacklist_admin" ON email_blacklist
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

COMMENT ON TABLE email_delivery_logs IS 'メール配信ログ。Resend との連携ログ。';
COMMENT ON TABLE email_blacklist IS 'メールブラックリスト。バウンス・苦情で自動追加。';

-- =====================================================
-- §3.20 同意管理テーブル群 (cross/08-legal-compliance.md canonical)
-- =====================================================

-- §3.20-1 cookie_consents (cross/08-legal-compliance.md §12.2)
CREATE TABLE IF NOT EXISTS cookie_consents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES auth.users(id) ON DELETE CASCADE,  -- nullable (未ログイン時)
  session_id     VARCHAR(255),  -- ブラウザセッション識別子
  analytics      BOOLEAN     NOT NULL DEFAULT FALSE,
  advertising    BOOLEAN     NOT NULL DEFAULT FALSE,
  consented_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address     INET,
  user_agent     TEXT
);

ALTER TABLE cookie_consents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'cookie_consents' AND policyname = 'cookie_consents_self'
  ) THEN
    CREATE POLICY "cookie_consents_self" ON cookie_consents
      FOR ALL USING (
        auth.uid() = user_id
        OR user_id IS NULL
      );
  END IF;
END $$;

COMMENT ON TABLE cookie_consents IS 'Cookie 同意記録。改正電気通信事業法準拠。未ログイン時は user_id=NULL。';

-- §3.20-2 external_data_consents (cross/08-legal-compliance.md §4.3)
CREATE TABLE IF NOT EXISTS external_data_consents (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     VARCHAR(50) NOT NULL CHECK (provider IN ('xai', 'anthropic', 'google', 'openai')),
  consented    BOOLEAN     NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   INET,
  user_agent   TEXT,
  revoked_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_consents_active ON external_data_consents (user_id, provider)
  WHERE revoked_at IS NULL;  -- 有効な同意は1件のみ

ALTER TABLE external_data_consents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'external_data_consents' AND policyname = 'ext_consent_self_read'
  ) THEN
    CREATE POLICY "ext_consent_self_read"
      ON external_data_consents FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'external_data_consents' AND policyname = 'ext_consent_self_insert'
  ) THEN
    CREATE POLICY "ext_consent_self_insert"
      ON external_data_consents FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- 取消: revoked_at を UPDATE (DELETE 禁止、監査目的で保持)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'external_data_consents' AND policyname = 'ext_consent_no_delete'
  ) THEN
    CREATE POLICY "ext_consent_no_delete"
      ON external_data_consents FOR DELETE USING (false);
  END IF;
END $$;

COMMENT ON TABLE external_data_consents IS '外国第三者提供同意 (個人情報保護法24条)。xAI/Anthropic/Google/OpenAI。';

-- §3.20-3 terms_acceptances (cross/08-legal-compliance.md §7.1)
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type   VARCHAR(50) NOT NULL
    CHECK (document_type IN (
      'terms_of_service',
      'privacy_policy',
      'parental_consent',
      'external_data_provision'
    )),
  document_version VARCHAR(20) NOT NULL,  -- 例: "v2026.1"
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user ON terms_acceptances (user_id, document_type, document_version);

ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'terms_acceptances' AND policyname = 'terms_self_read'
  ) THEN
    CREATE POLICY "terms_self_read"
      ON terms_acceptances FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'terms_acceptances' AND policyname = 'terms_self_insert'
  ) THEN
    CREATE POLICY "terms_self_insert"
      ON terms_acceptances FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- UPDATE / DELETE 禁止 (同意記録は不可逆)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'terms_acceptances' AND policyname = 'terms_no_update'
  ) THEN
    CREATE POLICY "terms_no_update"
      ON terms_acceptances FOR UPDATE USING (false);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'terms_acceptances' AND policyname = 'terms_no_delete'
  ) THEN
    CREATE POLICY "terms_no_delete"
      ON terms_acceptances FOR DELETE USING (false);
  END IF;
END $$;

COMMENT ON TABLE terms_acceptances IS '利用規約・プライバシーポリシー同意記録。不可逆(UPDATE/DELETE禁止)。';

-- =====================================================
-- §3.21 gdpr_deletion_requests
-- =====================================================

CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooling_until   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  cancelled_at    TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  certificate_url TEXT,
  executed_by     UUID REFERENCES auth.users(id),  -- NULL = 自動バッチ
  notes           TEXT
);

ALTER TABLE gdpr_deletion_requests ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'gdpr_deletion_requests' AND policyname = 'gdpr_select'
  ) THEN
    CREATE POLICY "gdpr_select" ON gdpr_deletion_requests
      FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND ARRAY['admin','super_admin']::TEXT[] && roles
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'gdpr_deletion_requests' AND policyname = 'gdpr_insert_self'
  ) THEN
    CREATE POLICY "gdpr_insert_self" ON gdpr_deletion_requests
      FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- UPDATE (cancel / execute): 本人キャンセルまたは super_admin
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'gdpr_deletion_requests' AND policyname = 'gdpr_update'
  ) THEN
    CREATE POLICY "gdpr_update" ON gdpr_deletion_requests
      FOR UPDATE USING (
        (user_id = auth.uid() AND executed_at IS NULL)
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
        )
      );
  END IF;
END $$;

COMMENT ON TABLE gdpr_deletion_requests IS 'GDPR/個人情報消去リクエスト。30日クーリングオフ後実行。';

-- =====================================================
-- §3.23 password_history
-- =====================================================

CREATE TABLE IF NOT EXISTS password_history (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  password_hash VARCHAR(255) NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, changed_at)
);

-- 最新 N 件のみ参照するためのインデックス
CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history(user_id, changed_at DESC);

ALTER TABLE password_history ENABLE ROW LEVEL SECURITY;

-- service_role のみアクセス (パスワード検証は Edge Function 内)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'password_history' AND policyname = 'password_history_no_direct_access'
  ) THEN
    CREATE POLICY "password_history_no_direct_access" ON password_history
      FOR ALL USING (false);
  END IF;
END $$;

COMMENT ON TABLE password_history IS 'パスワード履歴。service_role のみアクセス(パスワード再利用防止)。';

-- =====================================================
-- §3.24 failed_invite_lookups
-- =====================================================

-- 招待トークン総当たり攻撃の検知・レート制限用
CREATE TABLE IF NOT EXISTS failed_invite_lookups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address  INET NOT NULL,
  token_hint  VARCHAR(10),  -- トークン最初の 10 文字 (診断用)
  invite_type VARCHAR(20) CHECK (invite_type IN ('family','org')),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_invites_ip ON failed_invite_lookups(ip_address, attempted_at DESC);

-- 7 日以上古いレコードは pg_cron で削除
ALTER TABLE failed_invite_lookups ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'failed_invite_lookups' AND policyname = 'failed_invites_no_access'
  ) THEN
    CREATE POLICY "failed_invites_no_access" ON failed_invite_lookups
      FOR ALL USING (false);
  END IF;
END $$;
-- service_role のみ (middleware 経由)

COMMENT ON TABLE failed_invite_lookups IS '招待トークン総当たり攻撃検知・レート制限用。7日超は pg_cron で削除。';

-- =====================================================
-- §3.25 user_sessions_metadata
-- =====================================================

CREATE TABLE IF NOT EXISTS user_sessions_metadata (
  session_id    VARCHAR(255) PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name   VARCHAR(200),
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions_metadata(user_id, last_active_at DESC);

ALTER TABLE user_sessions_metadata ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_sessions_metadata' AND policyname = 'sessions_self'
  ) THEN
    CREATE POLICY "sessions_self" ON user_sessions_metadata
      FOR SELECT USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_sessions_metadata' AND policyname = 'sessions_revoke_self'
  ) THEN
    CREATE POLICY "sessions_revoke_self" ON user_sessions_metadata
      FOR UPDATE USING (user_id = auth.uid());
  END IF;
END $$;

COMMENT ON TABLE user_sessions_metadata IS 'ユーザーセッションメタデータ。デバイス管理・セッション失効に使用。';

COMMIT;
