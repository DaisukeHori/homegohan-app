-- migration: 20260710210029_feature_flags_table.sql
-- #1029 [Crit]: super-admin の機能フラグ API が実質 no-op で、フラグ機構全体が
-- 無効化されていた。
--   - PATCH/DELETE はフラグ状態を保存する UPDATE/DELETE を一切持たず監査ログのみ
--   - GET は常に enabled:true をハードコードして返す
--   - enabled/rollout_strategy/constraints を永続化する実テーブルが存在しない
--     (feature_packages.feature_flags は「パッケージがどのキーを含むか」の配列に
--      過ぎず、フラグ自体の ON/OFF・ロールアウト状態を保持する場所ではない)
--
-- 本 migration は「フラグ定義そのもの」を保持する feature_flags テーブルを新設する。
-- API 側 (src/app/api/super-admin/flags/**) はこのテーブルに対して実際に
-- INSERT/UPDATE/DELETE/SELECT するよう修正し (同コミットのコード変更)、
-- アプリ側の評価関数 evaluateFlag はここに保存された enabled/rollout_strategy/
-- constraints を実際に判定する (src/lib/super-admin/evaluate-flag.ts)。
--
-- 冪等性: CREATE TABLE IF NOT EXISTS + DO $$ ... EXCEPTION WHEN duplicate_object
-- で 2 回連続実行してもエラー 0 になる。

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               VARCHAR(100) NOT NULL UNIQUE,
  description       TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  -- { type: 'all'|'percentage'|'plan'|'role'|'org', value?, plans?, roles?, org_ids? }
  -- NULL = rollout_strategy 未設定 (evaluateFlag は 'all' 相当として扱う)
  rollout_strategy  JSONB,
  -- { min_user_age_days?, exclude_plans?, include_plans?, include_roles?, include_org_ids? }
  constraints       JSONB,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.feature_flags IS
  '機能フラグ定義。enabled/rollout_strategy/constraints は super-admin API (PATCH) から実更新され、
   evaluateFlag (src/lib/super-admin/evaluate-flag.ts) がユーザーコンテキストに対し実判定する。
   feature_packages.feature_flags (VARCHAR配列) とは別概念 — そちらは「パッケージが含むフラグキー一覧」。';

-- =====================================================
-- RLS: super_admin 限定 (SELECT/INSERT/UPDATE/DELETE 全て)
--   一般ユーザー向けのフラグ評価 (evaluateFlag) は service_role 経由
--   (getSupabaseAdmin()) で RLS をバイパスして行う。
-- =====================================================

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'feature_flags' AND policyname = 'feature_flags_super_admin_all'
  ) THEN
    CREATE POLICY "feature_flags_super_admin_all" ON public.feature_flags
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
