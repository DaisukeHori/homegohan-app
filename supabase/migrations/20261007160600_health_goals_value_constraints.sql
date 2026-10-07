-- migration: 20261007160600_health_goals_value_constraints.sql
-- health_goals (健康目標) の target_value / current_value / goal_type に CHECK 制約を足す (#1229)
--
-- 背景:
--   2026-10-07 の本番スナップショット (supabase/baseline/prod_schema.sql) の health_goals は、値の列が次のとおり。
--     target_value  numeric(10,2) NOT NULL  ← 桁あふれは防げるが、-50 や 0 が入る
--     current_value numeric(10,2)           ← 負の値が入る
--     goal_type     text NOT NULL           ← '' や 'x y'、日本語、長大な文字列でも入る
--   (status にだけ health_goals_status_check がある。リポジトリの旧 migration 20260508190000 には無く、本番のテーブルに元からあったもの。
--    #1116 でベースライン (20251126124224) に入った)
--   RLS で見えるのは本人の行だけだが、アプリ (POST /api/health/goals など) の入力検証は、PostgREST を直接叩けば迂回できる。
--   アプリの検証が効かない経路でも守れるのは DB の制約だけ。
--   異常な値 (例: 体重の目標が -50) は、AI 相談のプロンプト (health_goals の行をそのまま載せる) や栄養目標の計算に波及する。
--
-- 変更 (制約は 4 本。1 本目は本番に既にある制約の明文化で、本番では何も変わらない):
--   1. health_goals_status_check            CHECK (status IN ('active','achieved','paused','cancelled'))
--      本番のテーブルに元からある制約の明文化。#1116 より前の migration の連なりには無く、いまはベースライン経由で入っている。
--      migration にも書いておき、制約が無い環境 (旧い連なりから作った DB など) にだけ追加する。
--      本番には既に (検証済みで) あるので、ここでは何も起きない。
--   2. health_goals_target_value_positive   CHECK (target_value > 0)
--   3. health_goals_current_value_nonnegative CHECK (current_value IS NULL OR current_value >= 0)
--      current_value は NULL (未計測) を許す。0 は有効な計測値 (例: 今日の歩数 0 歩) なので >= 0。
--   4. health_goals_goal_type_format        CHECK (goal_type ~ '^[a-z][a-z0-9_-]{0,63}$')
--      goal_type は DB では列挙にせず「形式」だけを見る。種類を足すたびに migration を要さないようにするため。
--      (tests/integration/rls/health-recipes-own-policies.test.ts も 'rls-drift-…' という任意の種類で INSERT する)
--      使える種類 (weight / body_fat / steps / step_count / sleep_hours) と、種類ごとの値の範囲
--      (例: 体重 20〜300 kg) はアプリ層 (src/lib/health-goal-types.ts、src/lib/health-payloads.ts) で検証する。
--
-- 2〜4 は NOT VALID で追加する。
--   - 既存の行は検査しない (テーブルを走査しないので、データに違反があっても migration は失敗しない)。
--   - 追加後の INSERT と UPDATE からは検査する。UPDATE は、どの列を更新しても更新後の行全体が検査される。
--     そのため、もし違反している既存の行があれば、その行は値を直すまで更新できない (読み取りと削除は今までどおり)。
--   - 本番に違反行が無いことを確かめてから、別の migration で VALIDATE CONSTRAINT する (PR の本文に確認用の SELECT を載せた)。
--     この migration では VALIDATE しない。
--
-- 既存の正当な利用経路への影響: なし。
--   Web / モバイルの目標作成・更新は、アプリ層の検証 (同じ PR) を通ってから書き込むため、この制約には当たらない。
--   モバイルが送る goal_type (weight / body_fat / sleep_hours / step_count) も形式に合う。
--   このテーブルに触れる Edge Function (generate-health-insights) は SELECT だけ。
--   データを書き換える文 (UPDATE / DELETE) はこの migration に無い。
--
-- 冪等: pg_constraint を見て、同名の制約が無いときだけ追加する。2 回続けて流してもエラーにならず、
--   後で VALIDATE 済みにした制約を NOT VALID に戻すこともない。
-- 確認:
--   - tests/integration/rls/health-goals-constraints.test.ts (36 件)。修正前は、違反するはずの INSERT / UPDATE が通って 18 件が失敗し、
--     この migration の後は全件成功する。
--   - tests/integration/security/health-goals-api.test.ts (37 件)。実際の API ルートと、この制約を持つ DB をつないで確かめる。
-- ロールバック: supabase/rollbacks/20261007160600_health_goals_value_constraints.down.sql
-- マージ順: migration は version の順にマージすること (この version: 20261007160600)。

-- 1. status (本番に既にある制約の明文化)
DO $health_goals_status_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.health_goals'::regclass
      AND conname = 'health_goals_status_check'
  ) THEN
    ALTER TABLE public.health_goals
      ADD CONSTRAINT health_goals_status_check
      CHECK (status = ANY (ARRAY['active'::text, 'achieved'::text, 'paused'::text, 'cancelled'::text]))
      NOT VALID;
  END IF;
END
$health_goals_status_check$;

-- 2. target_value は正の数
DO $health_goals_target_value_positive$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.health_goals'::regclass
      AND conname = 'health_goals_target_value_positive'
  ) THEN
    ALTER TABLE public.health_goals
      ADD CONSTRAINT health_goals_target_value_positive
      CHECK (target_value > 0)
      NOT VALID;
  END IF;
END
$health_goals_target_value_positive$;

-- 3. current_value は NULL か 0 以上
DO $health_goals_current_value_nonnegative$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.health_goals'::regclass
      AND conname = 'health_goals_current_value_nonnegative'
  ) THEN
    ALTER TABLE public.health_goals
      ADD CONSTRAINT health_goals_current_value_nonnegative
      CHECK (current_value IS NULL OR current_value >= 0)
      NOT VALID;
  END IF;
END
$health_goals_current_value_nonnegative$;

-- 4. goal_type は小文字英字で始まる 64 文字以内の英数字・_・-
DO $health_goals_goal_type_format$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.health_goals'::regclass
      AND conname = 'health_goals_goal_type_format'
  ) THEN
    ALTER TABLE public.health_goals
      ADD CONSTRAINT health_goals_goal_type_format
      CHECK (goal_type ~ '^[a-z][a-z0-9_-]{0,63}$')
      NOT VALID;
  END IF;
END
$health_goals_goal_type_format$;
