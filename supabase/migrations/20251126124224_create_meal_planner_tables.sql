-- migration: 20251126124224_create_meal_planner_tables.sql
-- #1116: 本番スキーマのベースライン (migration の統合)
--
-- このファイルには、本番スキーマ一式 (supabase/baseline/ の prod_schema.sql, prod_function_acl.sql, prod_table_acl.sql, prod_storage.sql, prod_reference_data.sql) を入れている。
--   取得: 2026-10-07T13:41:29Z (prod-schema-snapshot.yml による読み取り専用のスナップショット)
--   本番の migration 台帳の最大 version: 20261007112200 (143 本)
-- 台帳の最大 version 以下の migration (143 本) はここに統合し、ほかのファイルはプレースホルダにした。
-- 統合前の中身は git の履歴 (コミット 6014b17 以前) を参照。
--
-- 本番への影響はない: 統合した version は全て本番で適用済み (台帳に記録済み) で、`supabase db push` は
-- version しか見ないため、このファイルが本番で実行されることはない。空の DB (ローカル・CI・
-- `supabase db diff` のシャドウ DB) に流したときだけ実行され、取得時点の本番と同じスキーマになる。
-- このファイルは scripts/baseline/squash_migrations.py が生成した。手で編集しないこと。

-- ===== supabase/baseline/prod_schema.sql =====



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";






CREATE TYPE "public"."family_role_enum" AS ENUM (
    'representative',
    'adult',
    'child'
);


ALTER TYPE "public"."family_role_enum" OWNER TO "postgres";


CREATE TYPE "public"."org_role_enum" AS ENUM (
    'owner',
    'admin',
    'member'
);


ALTER TYPE "public"."org_role_enum" OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."family_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "role" "public"."family_role_enum" NOT NULL,
    "display_name" "text",
    "relationship" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "share_meals" boolean DEFAULT true NOT NULL,
    "share_health" boolean DEFAULT false NOT NULL,
    "share_menu" boolean DEFAULT true NOT NULL,
    "child_profile" "jsonb",
    "avatar_color" "text" DEFAULT '#FF6B6B'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "removed_at" timestamp with time zone,
    CONSTRAINT "family_members_avatar_color_check" CHECK (("avatar_color" ~ '^#[0-9A-Fa-f]{6}$'::"text")),
    CONSTRAINT "family_members_child_profile_consistency" CHECK (((("role" = 'child'::"public"."family_role_enum") AND ("user_id" IS NULL) AND ("child_profile" IS NOT NULL)) OR (("user_id" IS NOT NULL) AND ("child_profile" IS NULL)))),
    CONSTRAINT "family_members_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'removed'::"text", 'left'::"text"])))
);


ALTER TABLE "public"."family_members" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_child_promotion"("p_token" "text", "p_share_meals" boolean DEFAULT true, "p_share_health" boolean DEFAULT false, "p_share_menu" boolean DEFAULT true) RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_member family_members;
  v_caller_email TEXT;
  v_constraint TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- (1) 非ロック読み: member_id 解決 + 終端 status の早期確定。
  --     終端 status (accepted/rejected/revoked/expired) は不変条件のため
  --     非ロック読みでも確定判定してよい。'pending' だけが遷移しうるので (3) で再検証する。
  --     member_id / token は全 RPC を通じて UPDATE されない不変列 → (2) でそのまま使える。
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'expired' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  ELSIF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (2) member 行を先にロック (canonical 順の先頭。request_child_promotion と同順)
  SELECT * INTO v_member FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行をロックし、(1) の 'pending' 判定を再検証
  --     ((1)→(3) の間に revoke/再送で遷移した可能性がある。member ロック保持中は
  --      canonical 順に従う他 RPC はもうこの行に触れないため、(3) 以降は安定)
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    IF v_request.status = 'expired' THEN
      RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- 期限切れ。status を 'expired' に UPDATE しても直後の RAISE で巻き戻るため書かない
  -- (status は 'pending' のまま。期限切れは常に expires_at で判定する)。
  IF v_request.expires_at < NOW() THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 対象者本人であることを「自分のメール」で検証 (呼び出し者自身 = 列挙オラクルにならない)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- member の状態検証 ((2) でロック済みの行が権威)
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し者が既にどこかの family に所属していないこと (クリーンパスの事前チェック)
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- G3 (v2): 同一本人の 2 token 並行 accept は uniq_family_members_user の 23505 を
  -- ALREADY_IN_FAMILY(409) へ正規化。他の unique violation は再 RAISE。
  BEGIN
    UPDATE family_members
      SET user_id = auth.uid(), child_profile = NULL, role = 'adult',
          share_meals = p_share_meals, share_health = p_share_health, share_menu = p_share_menu
      WHERE id = v_member.id
      RETURNING * INTO v_member;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uniq_family_members_user' THEN
        RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
      END IF;
      RAISE;
  END;

  -- 所属家族を本人のプロフィールに入れる。メールのリンクから新規登録して初期設定 (オンボーディング) より前に
  -- 承認した人は、まだプロフィール行が無い (auth.users → user_profiles を作るトリガーは無く、行は初期設定の
  -- 保存で作られる)。UPDATE だけだと 0 行で終わり、後から初期設定で作られる行の family_id は NULL のままになり、
  -- 家族の画面で「家族なし」扱いになる。行が無ければ、アプリの既定値 (/api/profile・/api/onboarding/progress と同じ
  -- nickname 'Guest'・age_group / gender 'unspecified') で作る。初期設定の日時は入れないため初期設定の流れは変わらない。
  -- (2026-10-07 オーナー判断。設計 v2/v3 からの追加)
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_member.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_promotion_requests
    SET status = 'accepted', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'request_id', v_request.id,
                             'requested_by', v_request.requested_by));

  RETURN v_member;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;


ALTER FUNCTION "public"."accept_child_promotion"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean DEFAULT true, "p_share_health" boolean DEFAULT false, "p_share_menu" boolean DEFAULT true) RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM family_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE family_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = v_invite.family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu
  ) RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = v_invite.family_id WHERE id = auth.uid();

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;


ALTER FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."family_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "representative_id" "uuid" NOT NULL,
    "plan_key" "text" DEFAULT 'free'::"text" NOT NULL,
    "member_limit" integer DEFAULT 4 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dissolved_at" timestamp with time zone,
    CONSTRAINT "family_groups_member_limit_check" CHECK ((("member_limit" > 0) AND ("member_limit" <= 20))),
    CONSTRAINT "family_groups_name_check" CHECK ((("length"("name") >= 1) AND ("length"("name") <= 60))),
    CONSTRAINT "family_groups_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'dissolved'::"text"])))
);


ALTER TABLE "public"."family_groups" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_family_id UUID;
  v_old_rep_id UUID;
  v_result family_groups%ROWTYPE;
BEGIN
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_family_id := v_proposal.scope_id;
  v_old_rep_id := v_proposal.from_user_id;

  -- ★(A) #1237 Fix: 承諾者が今も対象家族の active adult / representative であることを再検証。
  -- leave_family / remove_family_member は family_members.status を 'left' / 'removed' に、
  -- user_profiles.family_id を NULL に同一トランザクションで設定するため、
  -- status = 'active' 行の存在確認で「今も対象家族に所属」を判定できる。
  -- role IN ('representative','adult') は operator_force_representative_transfer
  -- (20260511000125) と対称の防御多層化。propose 側で child は既に
  -- CANNOT_TRANSFER_TO_CHILD で遮断されるため happy path には無影響。
  IF NOT EXISTS (
    SELECT 1 FROM family_members
      WHERE family_id = v_family_id
        AND user_id = auth.uid()
        AND status = 'active'
        AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) TOCTOU close
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (現行 20260711120000 と完全同一)
  UPDATE family_members SET role = 'adult'
    WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;


ALTER FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "uuid" NOT NULL,
    "nickname" "text" NOT NULL,
    "age_group" "text" NOT NULL,
    "gender" "text" NOT NULL,
    "goal_text" "text",
    "perf_modes" "text"[],
    "lifestyle" "jsonb",
    "diet_flags" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    "family_config" "jsonb" DEFAULT '{"adults": 1, "children": 0}'::"jsonb",
    "family_size" integer DEFAULT 1,
    "department" "text",
    "cheat_day_config" "jsonb" DEFAULT '{"enabled": false, "dayOfWeek": "Sunday", "frequency": "weekly"}'::"jsonb",
    "height" numeric,
    "weight" numeric,
    "occupation" "text",
    "age" integer,
    "body_fat_percentage" numeric,
    "muscle_mass" numeric,
    "basal_body_temp" numeric,
    "target_weight" numeric,
    "target_body_fat" numeric,
    "target_date" "date",
    "fitness_goals" "text"[] DEFAULT '{}'::"text"[],
    "industry" "text",
    "work_style" "text",
    "work_hours" "jsonb" DEFAULT '{"end": "18:00", "start": "09:00"}'::"jsonb",
    "overtime_frequency" "text",
    "commute" "jsonb" DEFAULT '{"method": "train", "minutes": 30}'::"jsonb",
    "business_trip_frequency" "text",
    "entertainment_frequency" "text",
    "desk_hours_per_day" integer,
    "sports_activities" "jsonb" DEFAULT '[]'::"jsonb",
    "gym_member" boolean DEFAULT false,
    "personal_trainer" boolean DEFAULT false,
    "weekly_exercise_minutes" integer DEFAULT 0,
    "health_conditions" "text"[] DEFAULT '{}'::"text"[],
    "medications" "text"[] DEFAULT '{}'::"text"[],
    "health_checkup_results" "jsonb",
    "pregnancy_status" "text",
    "menopause" boolean DEFAULT false,
    "sleep_quality" "text",
    "stress_level" "text",
    "bowel_movement" "text",
    "skin_condition" "text",
    "cold_sensitivity" boolean DEFAULT false,
    "swelling_prone" boolean DEFAULT false,
    "diet_style" "text" DEFAULT 'normal'::"text",
    "religious_restrictions" "text",
    "disliked_cooking_methods" "text"[] DEFAULT '{}'::"text"[],
    "wake_time" time without time zone,
    "sleep_time" time without time zone,
    "meal_times" "jsonb" DEFAULT '{"lunch": "12:00", "dinner": "19:00", "breakfast": "07:30"}'::"jsonb",
    "snacking_habit" "text",
    "alcohol_frequency" "text",
    "smoking" boolean DEFAULT false,
    "caffeine_intake" "text",
    "daily_water_ml" integer,
    "cooking_experience" "text" DEFAULT 'beginner'::"text",
    "specialty_cuisines" "text"[] DEFAULT '{}'::"text"[],
    "disliked_cooking" "text"[] DEFAULT '{}'::"text"[],
    "weekday_cooking_minutes" integer DEFAULT 30,
    "weekend_cooking_minutes" integer DEFAULT 60,
    "kitchen_appliances" "text"[] DEFAULT '{}'::"text"[],
    "meal_prep_ok" boolean DEFAULT true,
    "freezer_capacity" "text",
    "weekly_food_budget" integer,
    "shopping_frequency" "text",
    "preferred_stores" "text"[] DEFAULT '{}'::"text"[],
    "online_grocery" boolean DEFAULT false,
    "costco_member" boolean DEFAULT false,
    "organic_preference" "text",
    "cuisine_preferences" "jsonb" DEFAULT '{"chinese": 3, "western": 3, "japanese": 4}'::"jsonb",
    "taste_preferences" "jsonb" DEFAULT '{"sour": 3, "salty": 3, "spicy": 3, "sweet": 3, "umami": 4}'::"jsonb",
    "favorite_ingredients" "text"[] DEFAULT '{}'::"text"[],
    "favorite_dishes" "text"[] DEFAULT '{}'::"text"[],
    "texture_preferences" "text"[] DEFAULT '{}'::"text"[],
    "temperature_preference" "text",
    "presentation_importance" "text",
    "household_members" "jsonb" DEFAULT '[]'::"jsonb",
    "has_children" boolean DEFAULT false,
    "children_ages" integer[] DEFAULT '{}'::integer[],
    "has_elderly" boolean DEFAULT false,
    "pets" "text"[] DEFAULT '{}'::"text"[],
    "hobbies" "text"[] DEFAULT '{}'::"text"[],
    "weekend_activity" "text",
    "travel_frequency" "text",
    "outdoor_activities" "text"[] DEFAULT '{}'::"text"[],
    "sns_food_posting" boolean DEFAULT false,
    "region" "text",
    "climate_sensitivity" "text",
    "profile_completeness" integer DEFAULT 0,
    "last_profile_update" timestamp with time zone,
    "ai_learning_enabled" boolean DEFAULT true,
    "is_banned" boolean DEFAULT false,
    "banned_at" timestamp with time zone,
    "banned_reason" "text",
    "login_count" integer DEFAULT 0,
    "roles" "text"[] DEFAULT ARRAY['user'::"text"],
    "exercise_intensity" "text" DEFAULT 'moderate'::"text",
    "exercise_frequency" integer DEFAULT 3,
    "exercise_duration_per_session" integer DEFAULT 60,
    "exercise_types" "text"[] DEFAULT '{}'::"text"[],
    "nutrition_goal" "text" DEFAULT 'maintain'::"text",
    "weight_change_rate" "text" DEFAULT 'moderate'::"text",
    "competition_date" "date",
    "water_cutting" boolean DEFAULT false,
    "carb_cycling" boolean DEFAULT false,
    "supplement_use" "text"[] DEFAULT '{}'::"text"[],
    "meal_timing_preference" "text" DEFAULT 'standard'::"text",
    "onboarding_started_at" timestamp with time zone,
    "onboarding_completed_at" timestamp with time zone,
    "onboarding_progress" "jsonb",
    "servings_config" "jsonb" DEFAULT '{"default": 2, "byDayMeal": {}}'::"jsonb",
    "week_start_day" "text" DEFAULT 'monday'::"text",
    "radar_chart_nutrients" "text"[] DEFAULT ARRAY['caloriesKcal'::"text", 'proteinG'::"text", 'fatG'::"text", 'carbsG'::"text", 'fiberG'::"text", 'vitaminCMg'::"text"],
    "performance_profile" "jsonb" DEFAULT '{}'::"jsonb",
    "handson_tour_completed_at" timestamp with time zone,
    "handson_tour_skipped_at" timestamp with time zone,
    "frozen_at" timestamp with time zone,
    "frozen_reason" "text",
    "frozen_by" "uuid",
    "last_login_at" timestamp with time zone,
    "plan_key_cached" character varying(100),
    "health_checkup_guidance" "jsonb",
    "joined_org_at" "date",
    "is_active_in_org" boolean DEFAULT false NOT NULL,
    "org_role" "public"."org_role_enum",
    "family_id" "uuid",
    "unban_at" timestamp with time zone,
    "department_id" "uuid",
    CONSTRAINT "user_profiles_org_consistency" CHECK (((("organization_id" IS NULL) AND ("org_role" IS NULL)) OR (("organization_id" IS NOT NULL) AND ("org_role" IS NOT NULL))))
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_profiles"."fitness_goals" IS '目標: lose_weight, gain_weight, build_muscle, improve_skin, gut_health, etc';



COMMENT ON COLUMN "public"."user_profiles"."work_style" IS '勤務形態: fulltime, parttime, freelance, remote, shift';



COMMENT ON COLUMN "public"."user_profiles"."sports_activities" IS '[{name, frequency, intensity, time_of_day, purpose}]';



COMMENT ON COLUMN "public"."user_profiles"."health_conditions" IS '持病: 高血圧, 糖尿病, 脂質異常症, 貧血, etc';



COMMENT ON COLUMN "public"."user_profiles"."diet_style" IS '食事スタイル: normal, vegetarian, vegan, pescatarian, gluten_free, keto';



COMMENT ON COLUMN "public"."user_profiles"."cooking_experience" IS '料理経験: beginner, intermediate, advanced';



COMMENT ON COLUMN "public"."user_profiles"."household_members" IS '[{relation, age, allergies, preferences}]';



COMMENT ON COLUMN "public"."user_profiles"."roles" IS 'ユーザーのロール配列。user, support, org_admin, admin, super_admin のいずれか複数を持てる';



COMMENT ON COLUMN "public"."user_profiles"."exercise_intensity" IS '運動強度: light(軽い)/moderate(普通)/intense(激しい)/athlete(アスリート)';



COMMENT ON COLUMN "public"."user_profiles"."nutrition_goal" IS '栄養目標: lose_weight(減量)/gain_muscle(増量)/maintain(維持)/athlete_performance(競技パフォーマンス)';



COMMENT ON COLUMN "public"."user_profiles"."weight_change_rate" IS '体重変化ペース: slow(ゆっくり)/moderate(普通)/aggressive(積極的)';



COMMENT ON COLUMN "public"."user_profiles"."servings_config" IS '曜日別・食事別の人数設定。byDayMeal.monday.breakfast = 2 のような形式';



COMMENT ON COLUMN "public"."user_profiles"."week_start_day" IS '週の開始曜日（UIのカレンダー表示用）。monday, sunday 等。';



COMMENT ON COLUMN "public"."user_profiles"."radar_chart_nutrients" IS 'レーダーチャートに表示する栄養素のリスト（デフォルト: カロリー, タンパク質, 脂質, 炭水化物, 食物繊維, ビタミンC）';



COMMENT ON COLUMN "public"."user_profiles"."performance_profile" IS 'パフォーマンスプロファイル (静的設定)
{
  "sport": {
    "id": "tennis",                    -- スポーツID or "custom"
    "name": "テニス",                   -- 表示名（自由入力の場合）
    "role": "baseline",                -- ロール（プレースタイル）
    "experience": "intermediate",      -- beginner/intermediate/advanced
    "phase": "training",               -- training/competition/cut/recovery
    "demandVector": {                  -- 要求特性（0-1）
      "endurance": 0.7,
      "power": 0.5,
      "strength": 0.4,
      "technique": 0.8,
      "weightClass": 0,
      "heat": 0.6,
      "altitude": 0
    }
  },
  "growth": {
    "isUnder18": false,               -- 18歳未満フラグ
    "heightChangeRecent": null,       -- 直近の身長変化（cm）
    "growthProtectionEnabled": false  -- 成長保護モードON/OFF
  },
  "cut": {
    "enabled": false,                 -- 減量モード有効
    "targetWeight": null,             -- 目標体重
    "targetDate": null,               -- 目標日（計量日など）
    "strategy": "gradual"             -- gradual/rapid
  },
  "priorities": {                     -- 優先栄養素
    "protein": "high",
    "carbs": "moderate",
    "fat": "moderate",
    "hydration": "high"
  }
}';



COMMENT ON COLUMN "public"."user_profiles"."handson_tour_completed_at" IS '初回ハンズオンチュートリアル完了日時 (family/09)。NULL = 未完走';



COMMENT ON COLUMN "public"."user_profiles"."handson_tour_skipped_at" IS '初回ハンズオンチュートリアル明示スキップ or auto-skip 日時 (family/09)';



COMMENT ON COLUMN "public"."user_profiles"."frozen_at" IS '凍結日時。NULL = 凍結されていない / NOT NULL = 凍結中';



COMMENT ON COLUMN "public"."user_profiles"."frozen_reason" IS '凍結理由テキスト（最大 2000 文字想定）';



COMMENT ON COLUMN "public"."user_profiles"."frozen_by" IS '凍結を実行した admin ユーザーの auth.users.id';



COMMENT ON COLUMN "public"."user_profiles"."last_login_at" IS '最終ログイン日時 (auth.users.last_sign_in_at を Edge Function が同期)';



COMMENT ON COLUMN "public"."user_profiles"."plan_key_cached" IS 'personal_subscriptions の現在有効な plan_key キャッシュ (Edge Function が同期、常に最新とは限らない)';



COMMENT ON COLUMN "public"."user_profiles"."unban_at" IS '一時 BAN の解除予定日時。NULL = 無期限凍結 or 凍結なし。frozen_at が NOT NULL かつ unban_at が過去の場合はアクセス判定時 (requireUser/requireRole/middleware) に 自動解除扱いとする (#1030)。';



COMMENT ON COLUMN "public"."user_profiles"."department_id" IS '所属組織の部署 (departments.id)。本人は変更できない (guard_user_profiles_privileged)。脱退・除名で NULL に戻る。#1235';



CREATE OR REPLACE FUNCTION "public"."accept_org_invite"("p_token" "text") RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite organization_invites;
  v_user_profile user_profiles;
  v_caller_email TEXT;
  v_total_licenses INT;
  v_used_licenses INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待 fetch (★ Warning 2: SELECT FOR UPDATE で二重受諾防止)
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 状態チェック
  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE organization_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- email 一致チェック (auth.users から caller の email 取得)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- 既に他組織所属チェック
  SELECT * INTO v_user_profile FROM user_profiles WHERE id = auth.uid();
  IF v_user_profile.organization_id IS NOT NULL
     AND v_user_profile.organization_id <> v_invite.organization_id THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 自身が別 org の owner か (owner は脱退不可)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id <> v_invite.organization_id) THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- メンバ化
  UPDATE user_profiles
    SET organization_id = v_invite.organization_id,
        org_role = v_invite.invited_role,
        joined_org_at = CURRENT_DATE,
        is_active_in_org = TRUE
    WHERE id = auth.uid()
    RETURNING * INTO v_user_profile;

  -- 招待消化
  UPDATE organization_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  -- ★ F3-08: ライセンス使用数 increment 直前に上限を再チェック (座席超過防止)
  -- create_org_invite は発行時にしか上限を見ないため、複数招待の先行発行 →
  -- 全員 accept で座席超過するのを防ぐ。FOR UPDATE で同時実行時の競合も防止。
  SELECT total_licenses, used_licenses INTO v_total_licenses, v_used_licenses
    FROM org_license_pools WHERE organization_id = v_invite.organization_id FOR UPDATE;

  IF v_total_licenses IS NOT NULL AND v_used_licenses >= v_total_licenses THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- ライセンス使用数 increment
  UPDATE org_license_pools
    SET used_licenses = used_licenses + 1, updated_at = NOW()
    WHERE organization_id = v_invite.organization_id;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'role', v_invite.invited_role));

  RETURN v_user_profile;
END $$;


ALTER FUNCTION "public"."accept_org_invite"("p_token" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "plan" "text" DEFAULT 'standard'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "industry" "text",
    "employee_count" integer,
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "subscription_status" "text" DEFAULT 'trial'::"text",
    "subscription_expires_at" timestamp with time zone,
    "logo_url" "text",
    "contact_email" "text",
    "contact_name" "text",
    "owner_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "dissolved_at" timestamp with time zone,
    CONSTRAINT "organizations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'dissolved'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."organizations"."status" IS '組織状態: active / dissolved (operator が緊急解散時に dissolved)';



COMMENT ON COLUMN "public"."organizations"."dissolved_at" IS '解散実施時刻 (status = dissolved 時のみ NOT NULL)';



CREATE OR REPLACE FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
BEGIN
  -- pending かつ宛先が呼び出し元である proposal を取得 (既存挙動不変)
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- ★(A) #1236 Fix: 承諾者が今も対象組織のメンバであることを再検証。
  -- leave_org / remove_org_member / release_user_membership は organization_id を NULL に、
  -- 他組織 accept_org_invite は別 org 値に、いずれもアトミックに設定するため、
  -- organization_id = v_org_id の一致確認だけで「今も対象組織に所属」を判定できる。
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) #1236 Fix: status = 'pending' 条件つき UPDATE で二重受諾 / 競合 (TOCTOU) を閉じる。
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (順序・意味は現行 20260711120000 と完全同一)
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM organizations WHERE id = v_org_id;
  RETURN v_result;
END $$;


ALTER FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_family_child"("p_family_id" "uuid", "p_display_name" "text", "p_child_profile" "jsonb") RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members
    WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile)
  VALUES (p_family_id, NULL, 'child', p_display_name, p_child_profile)
  RETURNING * INTO v_member;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name));

  RETURN v_member;
END $$;


ALTER FUNCTION "public"."add_family_child"("p_family_id" "uuid", "p_display_name" "text", "p_child_profile" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) RETURNS TABLE("id" "uuid", "roles" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_new_roles TEXT[];
BEGIN
  SELECT up.roles INTO v_caller_roles FROM user_profiles up WHERE up.id = auth.uid();
  IF v_caller_roles IS NULL OR NOT (v_caller_roles && ARRAY['super_admin']) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_new_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);

  UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;

  RETURN QUERY SELECT p_user_id, v_new_roles;
END $$;


ALTER FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    auth.uid() = p_target_user_id
    OR EXISTS (
      SELECT 1 FROM family_members vm
      JOIN family_members tm ON vm.family_id = tm.family_id
      WHERE vm.user_id = auth.uid() AND vm.status = 'active'
        AND tm.user_id = p_target_user_id AND tm.status = 'active'
        AND tm.share_meals = TRUE
    );
$$;


ALTER FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weekly_menu_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "prompt" "text",
    "result_json" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "constraints" "jsonb" DEFAULT '{}'::"jsonb",
    "inventory_image_url" "text",
    "detected_ingredients" "jsonb" DEFAULT '[]'::"jsonb",
    "prediction_result" "jsonb",
    "mode" "text",
    "target_date" "date",
    "target_meal_type" "text",
    "target_meal_id" "uuid",
    "progress" "jsonb" DEFAULT '{"phase": "pending", "message": "準備中..."}'::"jsonb",
    "generated_data" "jsonb",
    "current_step" integer DEFAULT 1,
    "target_slots" "jsonb",
    "worker_id" "text",
    "worker_acquired_at" timestamp with time zone,
    "attempt_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."weekly_menu_requests" OWNER TO "postgres";


COMMENT ON COLUMN "public"."weekly_menu_requests"."mode" IS 'リクエストモード: weekly | single | regenerate | v4';



COMMENT ON COLUMN "public"."weekly_menu_requests"."target_date" IS '単一食事生成時の対象日付';



COMMENT ON COLUMN "public"."weekly_menu_requests"."target_meal_type" IS '単一食事生成時の対象食事タイプ (breakfast/lunch/dinner等)';



COMMENT ON COLUMN "public"."weekly_menu_requests"."target_meal_id" IS '単一食事生成時の対象食事ID（更新時）';



COMMENT ON COLUMN "public"."weekly_menu_requests"."progress" IS 'フェーズ進捗情報 {phase, message, percentage}';



COMMENT ON COLUMN "public"."weekly_menu_requests"."generated_data" IS '生成・レビュー済みの献立データを一時保存';



COMMENT ON COLUMN "public"."weekly_menu_requests"."current_step" IS '現在のステップ (1=生成, 2=レビュー, 3=完了処理)';



COMMENT ON COLUMN "public"."weekly_menu_requests"."target_slots" IS 'V4用: 生成対象スロット配列 [{date, mealType, plannedMealId?}, ...]';



CREATE OR REPLACE FUNCTION "public"."claim_menu_request"("p_worker_id" "text") RETURNS "public"."weekly_menu_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_row weekly_menu_requests;
BEGIN
  -- まず attempt_count >= 3 かつ status='queued' のレコードを failed に遷移
  UPDATE weekly_menu_requests
  SET status = 'failed',
      error_message = 'attempt_limit_exceeded',
      updated_at = now()
  WHERE status = 'queued'
    AND attempt_count >= 3;

  -- 通常の claim: attempt_count < 3 のみ対象
  UPDATE weekly_menu_requests
  SET status = 'processing',
      worker_id = p_worker_id,
      worker_acquired_at = now(),
      attempt_count = attempt_count + 1
  WHERE id = (
    SELECT id FROM weekly_menu_requests
    WHERE (
      (status = 'queued' AND attempt_count < 3)
      OR (status = 'processing' AND worker_acquired_at < now() - interval '5 minutes' AND attempt_count < 3)
    )
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;


ALTER FUNCTION "public"."claim_menu_request"("p_worker_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_handson_tour_sandbox_rows"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_meals_deleted   INT;
  v_daily_deleted   INT;
BEGIN
  -- meals 削除 (meal_nutrition_estimates は CASCADE で自動削除)
  WITH d AS (
    DELETE FROM meals
    WHERE is_sandbox = true
      AND created_at < NOW() - INTERVAL '90 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_meals_deleted FROM d;

  -- user_daily_meals 削除
  WITH d AS (
    DELETE FROM user_daily_meals
    WHERE is_sandbox = true
      AND created_at < NOW() - INTERVAL '90 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_daily_deleted FROM d;

  -- 監査ログ記録 (actor_id は NULL 許容: PR #830 で NOT NULL 解除済)
  INSERT INTO admin_audit_logs (action_type, target_type, severity, details)
  VALUES (
    'handson_tour_sandbox_cleanup',
    'cron_job',
    'info',
    jsonb_build_object(
      'meals_deleted',       v_meals_deleted,
      'daily_meals_deleted', v_daily_deleted
    )
  );

  RETURN jsonb_build_object(
    'meals_deleted',       v_meals_deleted,
    'daily_meals_deleted', v_daily_deleted
  );
END;
$$;


ALTER FUNCTION "public"."cleanup_handson_tour_sandbox_rows"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."cleanup_handson_tour_sandbox_rows"() IS 'handson tour の sandbox 行 (is_sandbox=true, 90 日超) を meals / user_daily_meals から削除し、削除件数を admin_audit_logs に記録する。pg_cron により毎日 04:00 UTC に実行される。';



CREATE OR REPLACE FUNCTION "public"."cleanup_old_logs"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;


ALTER FUNCTION "public"."cleanup_old_logs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_handson_tour"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_existing_completed_at timestamptz;
  v_completed_at timestamptz;
  v_was_already boolean;
  v_badge_id uuid;
  v_badge_name text;
  v_badge_icon_url text;
  v_badge_obtained_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- UPDATE 前に既存値を取得 (already_completed 判定のため)
  SELECT handson_tour_completed_at INTO v_existing_completed_at
  FROM user_profiles WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  v_was_already := (v_existing_completed_at IS NOT NULL);

  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE id = v_user_id
  RETURNING handson_tour_completed_at INTO v_completed_at;

  -- badges テーブルの列は icon (icon_url ではない。#1027 round-2 実測で判明:
  -- 旧関数から継承していた誤り。JSON レスポンスキーは icon_url を維持する
  -- (src/lib/handson-tour/schemas.ts の zod 契約に合わせる)。
  SELECT id, name, icon INTO v_badge_id, v_badge_name, v_badge_icon_url
  FROM badges WHERE code = 'tutorial_complete';

  IF v_badge_id IS NULL THEN
    RAISE EXCEPTION 'badge_not_found';
  END IF;

  INSERT INTO user_badges (user_id, badge_id, obtained_at)
  VALUES (v_user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;

  SELECT obtained_at INTO v_badge_obtained_at
  FROM user_badges WHERE user_id = v_user_id AND badge_id = v_badge_id;

  RETURN jsonb_build_object(
    'completed_at', v_completed_at,
    'badge_awarded', jsonb_build_object(
      'code', 'tutorial_complete',
      'name', v_badge_name,
      'obtained_at', v_badge_obtained_at,
      'icon_url', v_badge_icon_url
    ),
    'already_completed', v_was_already
  );
END;
$$;


ALTER FUNCTION "public"."complete_handson_tour"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."complete_handson_tour"() IS 'family/09 卒業処理: profile UPDATE + tutorial_complete バッジ INSERT を atomic に実行。#1027 修正: 引数を廃止し auth.uid() を内部参照 (他人のツアーを完了させる書き込み穴を防止)、authenticated に EXECUTE を明示的に GRANT (卒業不能バグを解消)。round-2: badges.icon_url→icon 列名修正、anon への default privilege 由来の暗黙 EXECUTE を明示 REVOKE。';



CREATE OR REPLACE FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text" DEFAULT 'free'::"text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          (SELECT nickname FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;


ALTER FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."family_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "token" "text" NOT NULL,
    "invited_role" "public"."family_role_enum" DEFAULT 'adult'::"public"."family_role_enum" NOT NULL,
    "custom_message" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "invited_by" "uuid",
    "accepted_by" "uuid",
    "accepted_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    CONSTRAINT "family_invites_invited_role_check" CHECK (("invited_role" = 'adult'::"public"."family_role_enum")),
    CONSTRAINT "family_invites_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'expired'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."family_invites" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_family_invite"("p_family_id" "uuid", "p_email" "text", "p_custom_message" "text" DEFAULT NULL::"text") RETURNS "public"."family_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite family_invites;
  v_token TEXT;
  v_caller_role family_role_enum;
  v_count INT;
  v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を revoke
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE family_id = p_family_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO family_invites (
    family_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_family_id, lower(p_email), v_token, 'adult', p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'invite_created', auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'email', lower(p_email)));

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."create_family_invite"("p_family_id" "uuid", "p_email" "text", "p_custom_message" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text",
    "department_id" "uuid",
    "token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invited_by" "uuid",
    "invited_role" "public"."org_role_enum" DEFAULT 'member'::"public"."org_role_enum" NOT NULL,
    "custom_message" "text",
    "accepted_by" "uuid",
    "rejected_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    CONSTRAINT "organization_invites_role_check" CHECK (("role" = ANY (ARRAY['member'::"text", 'manager'::"text", 'admin'::"text"]))),
    CONSTRAINT "organization_invites_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'expired'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."organization_invites" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum" DEFAULT 'member'::"public"."org_role_enum", "p_custom_message" "text" DEFAULT NULL::"text") RETURNS "public"."organization_invites"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum", "p_custom_message" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ownership_transfer_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" NOT NULL,
    "scope_id" "uuid" NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "proposed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "ownership_transfer_proposals_scope_check" CHECK (("scope" = ANY (ARRAY['organization'::"text", 'family'::"text"]))),
    CONSTRAINT "ownership_transfer_proposals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."ownership_transfer_proposals" OWNER TO "postgres";


COMMENT ON TABLE "public"."ownership_transfer_proposals" IS 'INSERT/UPDATE は SECURITY DEFINER RPC (propose_org_owner_transfer / propose_family_representative_transfer / accept_org_owner_transfer / accept_family_representative_transfer / decline_org_owner_transfer / decline_family_representative_transfer) 経由のみ。直接 INSERT/UPDATE は authenticated/anon ともに不可 (#1039 F3-06/F3-07 対応。000130 の設計方針を UPDATE にも適用)';



CREATE OR REPLACE FUNCTION "public"."decline_family_representative_transfer"("p_proposal_id" "uuid") RETURNS "public"."ownership_transfer_proposals"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_proposal ownership_transfer_proposals;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND scope = 'family';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.to_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- status='pending' を条件に含めた UPDATE で二重処理/競合を防止
  UPDATE ownership_transfer_proposals
    SET status = 'rejected', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_proposal.scope_id, 'representative_transfer_declined',
          auth.uid(), v_proposal.from_user_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN v_proposal;
END $$;


ALTER FUNCTION "public"."decline_family_representative_transfer"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decline_org_owner_transfer"("p_proposal_id" "uuid") RETURNS "public"."ownership_transfer_proposals"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_proposal ownership_transfer_proposals;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND scope = 'organization';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.to_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- status='pending' を条件に含めた UPDATE で二重処理/競合を防止
  UPDATE ownership_transfer_proposals
    SET status = 'rejected', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_proposal.scope_id, 'owner_transfer_declined',
          auth.uid(), v_proposal.from_user_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN v_proposal;
END $$;


ALTER FUNCTION "public"."decline_org_owner_transfer"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decrement_recipe_like_count"("p_recipe_id" "text" DEFAULT NULL::"text", "p_recipe_uuid" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."decrement_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fill_derived_recipes_magnesium_mg"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  elem jsonb;
  ing_id uuid;
  amount_g numeric;
  mg_per_100g numeric;
  total numeric := 0;
begin
  if new.magnesium_mg is not null then
    return new;
  end if;

  if new.ingredients is null then
    return new;
  end if;

  for elem in
    select * from jsonb_array_elements(new.ingredients)
  loop
    ing_id := (elem->>'matched_ingredient_id')::uuid;
    amount_g := (elem->>'amount_g')::numeric;

    if ing_id is null or amount_g is null then
      continue;
    end if;

    select i.magnesium_mg
      into mg_per_100g
    from public.dataset_ingredients i
    where i.id = ing_id;

    if mg_per_100g is null then
      continue;
    end if;

    total := total + mg_per_100g * (amount_g / 100.0);
  end loop;

  new.magnesium_mg := total;
  return new;
end;
$$;


ALTER FUNCTION "public"."fill_derived_recipes_magnesium_mg"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fill_planned_meals_magnesium_mg"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.magnesium_mg is null
     and new.source_type = 'dataset'
     and new.source_menu_set_external_id is not null then
    select dms.magnesium_mg
      into new.magnesium_mg
    from public.dataset_menu_sets dms
    where dms.external_id = new.source_menu_set_external_id
    limit 1;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."fill_planned_meals_magnesium_mg"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date" DEFAULT CURRENT_DATE) RETURNS TABLE("avg_sleep_hours" numeric, "avg_sleep_quality" numeric, "avg_fatigue" numeric, "avg_focus" numeric, "avg_hunger" numeric, "avg_training_rpe" numeric, "total_training_minutes" integer, "weight_start" numeric, "weight_end" numeric, "weight_delta" numeric, "checkin_count" integer)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH recent_checkins AS (
    SELECT *
    FROM user_performance_checkins
    WHERE user_id = p_user_id
      AND checkin_date BETWEEN (p_date - INTERVAL '6 days')::DATE AND p_date
    ORDER BY checkin_date
  ),
  weight_data AS (
    SELECT
      (SELECT weight FROM recent_checkins WHERE weight IS NOT NULL ORDER BY checkin_date LIMIT 1) as first_weight,
      (SELECT weight FROM recent_checkins WHERE weight IS NOT NULL ORDER BY checkin_date DESC LIMIT 1) as last_weight
  )
  SELECT
    ROUND(AVG(sleep_hours)::NUMERIC, 1),
    ROUND(AVG(sleep_quality)::NUMERIC, 1),
    ROUND(AVG(fatigue)::NUMERIC, 1),
    ROUND(AVG(focus)::NUMERIC, 1),
    ROUND(AVG(hunger)::NUMERIC, 1),
    ROUND(AVG(training_load_rpe)::NUMERIC, 1),
    COALESCE(SUM(training_minutes), 0)::INTEGER,
    wd.first_weight,
    wd.last_weight,
    ROUND((wd.last_weight - wd.first_weight)::NUMERIC, 2),
    COUNT(*)::INTEGER
  FROM recent_checkins rc
  CROSS JOIN weight_data wd
  GROUP BY wd.first_weight, wd.last_weight;
END;
$$;


ALTER FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date") IS '過去7日間のチェックインデータの移動平均を取得。個別最適化の判定に使用。';



CREATE OR REPLACE FUNCTION "public"."get_invite_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org_invite  organization_invites;
  v_fam_invite  family_invites;
  v_org_name    TEXT;
  v_fam_name    TEXT;
  v_invited_by_name TEXT;
  v_is_existing BOOLEAN;
  v_email_matches BOOLEAN;
BEGIN
  -- org 招待を検索
  SELECT * INTO v_org_invite
    FROM organization_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 組織名
    SELECT name INTO v_org_name FROM organizations WHERE id = v_org_invite.organization_id;

    -- 招待者名
    SELECT COALESCE(up.nickname, au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_org_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_org_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_org_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'organization',
      'scope_id',                v_org_invite.organization_id,
      'scope_name',              v_org_name,
      'role',                    v_org_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_org_invite.expires_at,
      'email',                   v_org_invite.email,
      'status',                  v_org_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- family 招待を検索
  SELECT * INTO v_fam_invite
    FROM family_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 家族名
    SELECT name INTO v_fam_name FROM family_groups WHERE id = v_fam_invite.family_id;

    -- 招待者名
    SELECT COALESCE(up.nickname, au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_fam_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_fam_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_fam_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'family',
      'scope_id',                v_fam_invite.family_id,
      'scope_name',              v_fam_name,
      'role',                    v_fam_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_fam_invite.expires_at,
      'email',                   v_fam_invite.email,
      'status',                  v_fam_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- 見つからない場合 NULL
  RETURN NULL;
END $$;


ALTER FUNCTION "public"."get_invite_details"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_promotion_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_family_name TEXT;
  v_member_name TEXT;
  v_requested_by_name TEXT;
  v_email_matches BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL; -- 見つからない場合 NULL (get_invite_details と同じ)
  END IF;

  SELECT name INTO v_family_name FROM family_groups WHERE id = v_request.family_id;
  SELECT display_name INTO v_member_name FROM family_members WHERE id = v_request.member_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requested_by_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = v_request.requested_by;

  v_email_matches := FALSE;
  IF auth.uid() IS NOT NULL THEN
    SELECT lower(au.email) = lower(v_request.email)
      INTO v_email_matches
      FROM auth.users au WHERE au.id = auth.uid();
  END IF;

  RETURN jsonb_build_object(
    'family_name', v_family_name,
    'member_display_name', v_member_name,
    'requested_by_name', v_requested_by_name,
    'email', v_request.email,
    'status', v_request.status,
    'expires_at', v_request.expires_at,
    'current_user_email_matches', v_email_matches
  );
END $$;


ALTER FUNCTION "public"."get_promotion_details"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_family_groups_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.representative_id IS DISTINCT FROM OLD.representative_id
       OR NEW.plan_key     IS DISTINCT FROM OLD.plan_key
       OR NEW.member_limit IS DISTINCT FROM OLD.member_limit THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_family_groups_privileged"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_family_members_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;

    -- #1015: 共有設定 (share_meals/share_health/share_menu) は本人のみ直接 UPDATE 可。
    -- 子供メンバー等 (OLD.user_id IS NULL) は「本人」が存在しないため常に拒否され、
    -- 変更が必要な場合は DEFINER RPC 経由での対応が必要。
    IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
      IF NEW.share_meals  IS DISTINCT FROM OLD.share_meals
         OR NEW.share_health IS DISTINCT FROM OLD.share_health
         OR NEW.share_menu   IS DISTINCT FROM OLD.share_menu THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_family_members_privileged"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_organizations_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.status  IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_organizations_privileged"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_user_profiles_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_user_profiles_privileged"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_user_profiles_privileged_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_user_profiles_privileged_on_insert"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."guard_user_profiles_privileged_on_insert"() IS 'user_profiles の特権列 (guard_user_profiles_privileged と同じ列) を、authenticated / anon が自分の行を作るときに既定値以外にさせない。';



CREATE OR REPLACE FUNCTION "public"."increment_recipe_like_count"("p_recipe_id" "text" DEFAULT NULL::"text", "p_recipe_uuid" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."increment_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_recipe_view_count"("recipe_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE recipes
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = recipe_id;
$$;


ALTER FUNCTION "public"."increment_recipe_view_count"("recipe_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_catalog_import"("p_function_name" "text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_url text;
  v_headers jsonb;
  v_request_id bigint;
  v_secret text;
BEGIN
  -- #1020: p_function_name の無検証 URL 連結による SSRF/confused deputy を防ぐため許可リスト化
  IF p_function_name NOT IN (
    'import-seven-eleven-catalog',
    'import-familymart-catalog',
    'import-lawson-catalog',
    'import-natural-lawson-catalog',
    'import-ministop-catalog'
  ) THEN
    RAISE EXCEPTION 'invoke_catalog_import: function name not allowed: %', p_function_name;
  END IF;

  -- Vault から secret 取得
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'app_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'app_cron_secret not found in Vault. Run: SELECT vault.create_secret(...) once.';
  END IF;

  v_url := 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/' || p_function_name;
  v_headers := jsonb_build_object(
    'Authorization', 'Bearer ' || v_secret,
    'Content-Type', 'application/json'
  );
  SELECT net.http_post(url := v_url, headers := v_headers, body := '{}'::jsonb)
    INTO v_request_id;
  RETURN v_request_id;
END;
$$;


ALTER FUNCTION "public"."invoke_catalog_import"("p_function_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = p_family_id
      AND fm.user_id = auth.uid()
      AND fm.role IN ('representative', 'adult')
      AND fm.status = 'active'
  );
$$;


ALTER FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") IS 'RLS 用: ログイン中のユーザーが、その家族の active な代表者・大人か。family_members のポリシーの自己参照による無限再帰を避けるため SECURITY DEFINER (#1257)。';



CREATE OR REPLACE FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = p_family_id
      AND fm.user_id = auth.uid()
      AND fm.status = 'active'
  );
$$;


ALTER FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") IS 'RLS 用: ログイン中のユーザーが、その家族の active なメンバーか。family_members のポリシーの自己参照による無限再帰を避けるため SECURITY DEFINER (#1257)。';



CREATE OR REPLACE FUNCTION "public"."is_inactive_user"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_last_sign_in TIMESTAMPTZ;
BEGIN
  SELECT last_sign_in_at
  INTO v_last_sign_in
  FROM auth.users
  WHERE id = p_user_id;

  -- ユーザーが存在しない
  IF NOT FOUND THEN
    RETURN TRUE;
  END IF;

  -- 30 日以上 sign-in なし または一度もサインインしていない
  RETURN (v_last_sign_in IS NULL OR v_last_sign_in < NOW() - INTERVAL '30 days');
END $$;


ALTER FUNCTION "public"."is_inactive_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."leave_family"() RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_member family_members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_member FROM family_members WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  IF v_member.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'left', removed_at = NOW()
    WHERE id = v_member.id
    RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = NULL WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_member.family_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_member;
END $$;


ALTER FUNCTION "public"."leave_family"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."leave_org"() RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_user user_profiles; v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM user_profiles WHERE id = auth.uid();
  IF v_user.organization_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.org_role = 'owner' THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_user.organization_id;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;


ALTER FUNCTION "public"."leave_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_families_with_inactive_representative"() RETURNS TABLE("family_id" "uuid", "family_name" "text", "representative_user_id" "uuid", "representative_email" "text", "member_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    fg.id                         AS family_id,
    fg.name                       AS family_name,
    fm.user_id                    AS representative_user_id,
    au.email                      AS representative_email,
    (SELECT COUNT(*)
       FROM family_members mc
       WHERE mc.family_id = fg.id AND mc.status = 'active'
    )                             AS member_count
  FROM family_groups fg
  JOIN family_members fm ON fm.family_id = fg.id
                         AND fm.role = 'representative'
                         AND fm.status = 'active'
  JOIN auth.users au ON au.id = fm.user_id
  WHERE fg.status = 'active'
    AND (au.last_sign_in_at IS NULL
         OR au.last_sign_in_at < NOW() - INTERVAL '30 days');
END $$;


ALTER FUNCTION "public"."list_families_with_inactive_representative"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_orgs_with_inactive_owner"() RETURNS TABLE("organization_id" "uuid", "organization_name" "text", "owner_user_id" "uuid", "owner_email" "text", "owner_last_sign_in" timestamp with time zone, "member_count" bigint, "dissolved" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    o.id                          AS organization_id,
    o.name                        AS organization_name,
    up.id                         AS owner_user_id,
    au.email                      AS owner_email,
    au.last_sign_in_at            AS owner_last_sign_in,
    (SELECT COUNT(*)
       FROM user_profiles mp
       WHERE mp.organization_id = o.id
    )                             AS member_count,
    (o.status = 'dissolved')      AS dissolved
  FROM organizations o
  JOIN user_profiles up ON up.organization_id = o.id AND up.org_role = 'owner'
  JOIN auth.users au ON au.id = up.id
  WHERE au.last_sign_in_at IS NULL
     OR au.last_sign_in_at < NOW() - INTERVAL '30 days';
END $$;


ALTER FUNCTION "public"."list_orgs_with_inactive_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_dish_name"("name" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  return lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(name, ''), '[\s　]+', '', 'g'),        -- 空白除去（半角/全角）
          '（[^）]*）', '', 'g'                                          -- 全角括弧ごと除去
        ),
        '\\([^)]*\\)', '', 'g'                                      -- 半角括弧ごと除去
      ),
      '[・･]', '', 'g'                                                  -- 中点除去
    )
  );
end;
$$;


ALTER FUNCTION "public"."normalize_dish_name"("name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  UPDATE family_groups
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;


ALTER FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE organization_id = p_organization_id;

  -- Round 3 C-4: org_license_pools の used_licenses をリセット
  UPDATE org_license_pools
    SET used_licenses = 0, updated_at = NOW()
    WHERE organization_id = p_organization_id;

  -- organizations.status を dissolved に更新 (000126 で追加したカラム)
  UPDATE organizations
    SET status = 'dissolved',
        dissolved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW()
    )
  );

  RETURN v_org;
END;
$$;


ALTER FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org organizations;
  v_old_owner_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM user_profiles WHERE id = p_new_owner_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id;

  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;


ALTER FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id;

  UPDATE family_members SET role = 'adult'
    WHERE family_id = p_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active';
  UPDATE family_groups SET representative_id = p_new_rep_id
    WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_rep_id', v_old_rep_id,
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;


ALTER FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = p_org_id
        AND up.org_role IN ('owner','admin')
    )
    THEN p_new_owner_id IS NOT DISTINCT FROM (
      SELECT o.owner_id FROM organizations o WHERE o.id = p_org_id
    )
    ELSE false
  END;
$$;


ALTER FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."paste_meal_to_family"("p_source_meal_id" "uuid", "p_target_user_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_source meals;
  v_paste_group_id UUID;
  v_target UUID;
  v_caller_family_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_source FROM meals WHERE id = p_source_meal_id;
  IF v_source.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'NOT_MEAL_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT family_id INTO v_caller_family_id FROM user_profiles WHERE id = auth.uid();
  IF v_caller_family_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  v_paste_group_id := COALESCE(v_source.paste_group_id, gen_random_uuid());

  IF v_source.paste_group_id IS NULL THEN
    UPDATE meals SET paste_group_id = v_paste_group_id WHERE id = p_source_meal_id;
  END IF;

  FOREACH v_target IN ARRAY p_target_user_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM family_members
      WHERE family_id = v_caller_family_id AND user_id = v_target AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO meals (
      user_id, paste_group_id, eaten_at, meal_type, photo_url, memo
    )
    SELECT
      v_target, v_paste_group_id, eaten_at, meal_type, photo_url, memo
    FROM meals WHERE id = p_source_meal_id;
  END LOOP;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', v_caller_family_id, 'paste_executed', auth.uid(),
          jsonb_build_object('source_meal_id', p_source_meal_id,
                             'paste_group_id', v_paste_group_id,
                             'target_count', array_length(p_target_user_ids, 1)));

  RETURN v_paste_group_id;
END $$;


ALTER FUNCTION "public"."paste_meal_to_family"("p_source_meal_id" "uuid", "p_target_user_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_family_invite"("p_token" "text") RETURNS TABLE("family_id" "uuid", "family_name" "text", "email" "text", "role" "public"."family_role_enum", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    fi.family_id,
    fg.name AS family_name,
    fi.email,
    fi.invited_role AS role,
    fi.expires_at
  FROM family_invites fi
  JOIN family_groups fg ON fg.id = fi.family_id
  WHERE fi.token = p_token
    AND fi.status = 'pending'
    AND fi.expires_at > NOW();
END;
$$;


ALTER FUNCTION "public"."preview_family_invite"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_org_invite"("p_token" "text") RETURNS TABLE("organization_id" "uuid", "organization_name" "text", "email" "text", "role" "public"."org_role_enum", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    oi.organization_id,
    o.name AS organization_name,
    oi.email,
    oi.invited_role AS role,
    oi.expires_at
  FROM organization_invites oi
  JOIN organizations o ON o.id = oi.organization_id
  WHERE oi.token = p_token
    AND oi.status = 'pending'
    AND oi.expires_at > NOW();
END;
$$;


ALTER FUNCTION "public"."preview_org_invite"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promote_child_to_user"("p_member_id" "uuid", "p_email" "text") RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RAISE EXCEPTION 'PROMOTION_DIRECT_DISABLED' USING ERRCODE = 'P0001';
END $$;


ALTER FUNCTION "public"."promote_child_to_user"("p_member_id" "uuid", "p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."propose_family_representative_transfer"("p_family_id" "uuid", "p_to_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_caller_role family_role_enum; v_target_role family_role_enum; v_proposal_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role <> 'representative' THEN
    RAISE EXCEPTION 'NOT_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  SELECT role INTO v_target_role FROM family_members
    WHERE family_id = p_family_id AND user_id = p_to_user_id AND status = 'active';
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_target_role = 'child' THEN
    RAISE EXCEPTION 'CANNOT_TRANSFER_TO_CHILD' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'family' AND scope_id = p_family_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('family', p_family_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'representative_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;


ALTER FUNCTION "public"."propose_family_representative_transfer"("p_family_id" "uuid", "p_to_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."propose_org_owner_transfer"("p_organization_id" "uuid", "p_to_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_caller_role org_role_enum; v_target_role org_role_enum; v_proposal_id UUID;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT org_role INTO v_target_role FROM user_profiles
    WHERE id = p_to_user_id AND organization_id = p_organization_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'organization' AND scope_id = p_organization_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('organization', p_organization_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'owner_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;


ALTER FUNCTION "public"."propose_org_owner_transfer"("p_organization_id" "uuid", "p_to_user_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."family_promotion_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "token" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '14 days'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    CONSTRAINT "family_promotion_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'revoked'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."family_promotion_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."family_promotion_requests" IS '#1232: 子供メンバー枠への本人同意 (昇格リクエスト)。書き込みは request/accept/reject/revoke_child_promotion RPC のみ。token 列は authenticated から読めない (列単位 GRANT)。';



CREATE OR REPLACE FUNCTION "public"."reject_child_promotion"("p_token" "text") RETURNS "public"."family_promotion_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- (1) 非ロック読み
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (2) member 行ロック (行が消えていれば request も CASCADE 済み = NOT_FOUND 扱い)
  PERFORM 1 FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行ロック + 再検証
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;
  -- 期限切れ (pending のまま日付超過) でも拒否は許可 (v2 踏襲: 本人の意思表示を優先)

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_promotion_requests
    SET status = 'rejected', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id
    RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_request.family_id, 'child_promotion_rejected', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_request.member_id, 'request_id', v_request.id));

  RETURN v_request;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;


ALTER FUNCTION "public"."reject_child_promotion"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_family_invite"("p_token" "text") RETURNS "public"."family_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite family_invites;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM family_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."reject_family_invite"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_org_invite"("p_token" "text") RETURNS "public"."organization_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite organization_invites;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE organization_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."reject_org_invite"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_user_membership"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF v_org_id IS NOT NULL THEN
    -- 対象を無効化してからカウントを減らす (leave_org と同じ冪等パターン)。
    -- WHERE organization_id = v_org_id が不成立 (=既に無効化済み) なら
    -- 0行 UPDATE となり、以降の decrement/監査ログもスキップされる。
    UPDATE user_profiles
      SET organization_id = NULL, org_role = NULL,
          is_active_in_org = FALSE, joined_org_at = NULL,
          roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
          department_id = NULL  -- #1235: 部署の所属も外す
      WHERE id = p_user_id AND organization_id = v_org_id;

    IF FOUND THEN
      UPDATE org_license_pools
        SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
        WHERE organization_id = v_org_id;

      INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
              jsonb_build_object('reason', 'account_delete'));
    END IF;
  END IF;
END $$;


ALTER FUNCTION "public"."release_user_membership"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_caller_role family_role_enum; v_target family_members;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM family_members WHERE id = p_member_id AND family_id = p_family_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'removed', removed_at = NOW()
    WHERE id = p_member_id
    RETURNING * INTO v_target;

  IF v_target.user_id IS NOT NULL THEN
    UPDATE user_profiles SET family_id = NULL WHERE id = v_target.user_id;
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', p_family_id, 'member_removed', auth.uid(), v_target.user_id);

  RETURN v_target;
END $$;


ALTER FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id;
  IF NOT FOUND OR v_target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = p_organization_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;


ALTER FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_child_promotion"("p_member_id" "uuid", "p_email" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
  v_token TEXT;
  v_family_name TEXT;
  v_requester_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- 認可を先に (email 解決より前 = 列挙オラクルを作らない)。member 不在時も
  -- v_member.family_id = NULL → ロール NULL → NOT_FAMILY_ADULT (存在有無を漏らさない)。
  -- この FOR UPDATE が canonical 順の先頭ロック。同一 member への並行
  -- request/revoke/accept/reject はこの行で完全直列化される。
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 対象は active な子供プレースホルダーであること
  -- (user_id IS NULL ⟺ role='child' は family_members_child_profile_consistency CHECK が保証)
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- 既存 pending の失効 (request 行ロックは member 行ロック取得済みの今なら安全)
  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE member_id = p_member_id AND status = 'pending';

  -- G4: gen_random_bytes は使用禁止 (pgcrypto/search_path 地雷 = 20260511000134 の教訓)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO family_promotion_requests
    (family_id, member_id, email, token, status, requested_by, expires_at)
  VALUES
    (v_member.family_id, p_member_id, lower(p_email), v_token, 'pending', auth.uid(),
     NOW() + INTERVAL '14 days')
  RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promotion_requested', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id,
                             'email', lower(p_email)));

  -- メール文面用の表示名 (auth.users 参照は SECURITY DEFINER 関数本体内のみ = 確立パターン)
  SELECT name INTO v_family_name FROM family_groups WHERE id = v_member.family_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requester_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = auth.uid();

  RETURN jsonb_build_object(
    'id',                  v_request.id,
    'family_id',           v_request.family_id,
    'member_id',           v_request.member_id,
    'member_display_name', v_member.display_name,
    'family_name',         v_family_name,
    'email',               v_request.email,
    'token',               v_request.token,
    'status',              v_request.status,
    'expires_at',          v_request.expires_at,
    'requester_name',      v_requester_name
  );
EXCEPTION
  WHEN deadlock_detected THEN
    -- #1232 v3 (G10): 他機能とのロック交差等で 40P01 になっても 500/UNKNOWN を漏らさず
    -- 再試行可能な競合 (409) として返す。副作用はサブトランザクションごと巻き戻り済み。
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;


ALTER FUNCTION "public"."request_child_promotion"("p_member_id" "uuid", "p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_e2e_test_users"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
DECLARE
  v_user03_id uuid;
  v_user04_id uuid;
BEGIN
  -- USER_03: onboarding_completed_at を NULL に戻す
  -- 対象: メールアドレスが e2e-user-03@*.test パターン
  SELECT au.id INTO v_user03_id
  FROM auth.users au
  WHERE au.email ~ '^e2e-user-03@.+\.test$'
  LIMIT 1;

  IF v_user03_id IS NOT NULL THEN
    UPDATE public.user_profiles
    SET onboarding_completed_at = NULL
    WHERE id = v_user03_id;

    RAISE NOTICE 'USER_03 (%) の onboarding_completed_at を NULL にリセットしました', v_user03_id;
  ELSE
    RAISE NOTICE 'USER_03 (e2e-user-03@*.test) が見つかりません。スキップします';
  END IF;

  -- USER_04: auth.users から DELETE (cascade で user_profiles も削除)
  -- 対象: メールアドレスが e2e-user-04@*.test パターン
  SELECT au.id INTO v_user04_id
  FROM auth.users au
  WHERE au.email ~ '^e2e-user-04@.+\.test$'
  LIMIT 1;

  IF v_user04_id IS NOT NULL THEN
    DELETE FROM auth.users WHERE id = v_user04_id;
    RAISE NOTICE 'USER_04 (%) を auth.users から削除しました (cascade)', v_user04_id;
  ELSE
    RAISE NOTICE 'USER_04 (e2e-user-04@*.test) が見つかりません。スキップします';
  END IF;
END;
$_$;


ALTER FUNCTION "public"."reset_e2e_test_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_child_promotion"("p_member_id" "uuid") RETURNS "public"."family_promotion_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_request FROM family_promotion_requests
    WHERE member_id = p_member_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id
    RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_request.family_id, 'child_promotion_revoked', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id));

  RETURN v_request;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;


ALTER FUNCTION "public"."revoke_child_promotion"("p_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_family_invite"("p_invite_id" "uuid") RETURNS "public"."family_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite family_invites;
  v_caller_role family_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待を取得
  SELECT * INTO v_invite FROM family_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し元が対象 family の representative/adult か検証
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_invite.family_id AND user_id = auth.uid() AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative', 'adult') THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- pending のみ revoke 可能
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE id = p_invite_id AND status = 'pending'
    RETURNING * INTO v_invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_revoked', auth.uid(),
          jsonb_build_object('invite_id', p_invite_id));

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."revoke_family_invite"("p_invite_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revoke_org_invite"("p_invite_id" "uuid") RETURNS "public"."organization_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite organization_invites;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待を取得
  SELECT * INTO v_invite FROM organization_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し元が対象 org の owner/admin か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM v_invite.organization_id
     OR v_caller_role IS NULL
     OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- pending のみ revoke 可能
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE id = p_invite_id AND status = 'pending'
    RETURNING * INTO v_invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_revoked', auth.uid(),
          jsonb_build_object('invite_id', p_invite_id));

  RETURN v_invite;
END $$;


ALTER FUNCTION "public"."revoke_org_invite"("p_invite_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_dataset_ingredients_by_embedding"("query_embedding" "extensions"."vector", "match_count" integer DEFAULT 10) RETURNS TABLE("id" "uuid", "name" "text", "calories_kcal" numeric, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "salt_eq_g" numeric, "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$ BEGIN PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true); PERFORM set_config('hnsw.max_scan_tuples', '20000', true); RETURN QUERY SELECT i.id, i.name, i.calories_kcal, i.protein_g, i.fat_g, i.carbs_g, i.salt_eq_g, (1 - (i.name_embedding <=> query_embedding))::double precision AS similarity FROM dataset_ingredients i WHERE i.name_embedding IS NOT NULL ORDER BY i.name_embedding <=> query_embedding ASC LIMIT match_count; END; $$;


ALTER FUNCTION "public"."search_dataset_ingredients_by_embedding"("query_embedding" "extensions"."vector", "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric DEFAULT 0.3, "result_limit" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "name" "text", "name_norm" "text", "calories_kcal" numeric, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "fiber_g" numeric, "sodium_mg" numeric, "potassium_mg" numeric, "calcium_mg" numeric, "magnesium_mg" numeric, "phosphorus_mg" numeric, "iron_mg" numeric, "zinc_mg" numeric, "iodine_ug" numeric, "cholesterol_mg" numeric, "vitamin_a_ug" numeric, "vitamin_d_ug" numeric, "vitamin_e_alpha_mg" numeric, "vitamin_k_ug" numeric, "vitamin_b1_mg" numeric, "vitamin_b2_mg" numeric, "vitamin_b6_mg" numeric, "vitamin_b12_ug" numeric, "folic_acid_ug" numeric, "vitamin_c_mg" numeric, "salt_eq_g" numeric, "discard_rate_percent" numeric, "similarity" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    i.id,
    i.name,
    i.name_norm,
    -- 基本栄養素
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.fiber_g,
    -- ミネラル
    i.sodium_mg,
    i.potassium_mg,
    i.calcium_mg,
    i.magnesium_mg,
    i.phosphorus_mg,
    i.iron_mg,
    i.zinc_mg,
    i.iodine_ug,
    i.cholesterol_mg,
    -- ビタミン
    i.vitamin_a_ug,
    i.vitamin_d_ug,
    i.vitamin_e_alpha_mg,
    i.vitamin_k_ug,
    i.vitamin_b1_mg,
    i.vitamin_b2_mg,
    i.vitamin_b6_mg,
    i.vitamin_b12_ug,
    i.folic_acid_ug,
    i.vitamin_c_mg,
    -- その他
    i.salt_eq_g,
    i.discard_rate_percent,
    -- 類似度（pg_trgm）
    similarity(i.name_norm, query_name) as similarity
  FROM dataset_ingredients i
  WHERE similarity(i.name_norm, query_name) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT result_limit;
$$;


ALTER FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) IS '材料名のテキスト類似度検索（フォールバック用）';



CREATE OR REPLACE FUNCTION "public"."search_ingredients_full_by_embedding"("query_embedding" "extensions"."vector", "match_count" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "name" "text", "name_norm" "text", "calories_kcal" numeric, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "fiber_g" numeric, "sodium_mg" numeric, "potassium_mg" numeric, "calcium_mg" numeric, "magnesium_mg" numeric, "phosphorus_mg" numeric, "iron_mg" numeric, "zinc_mg" numeric, "copper_mg" numeric, "manganese_mg" numeric, "iodine_ug" numeric, "selenium_ug" numeric, "chromium_ug" numeric, "molybdenum_ug" numeric, "cholesterol_mg" numeric, "vitamin_a_ug" numeric, "vitamin_d_ug" numeric, "vitamin_e_alpha_mg" numeric, "vitamin_k_ug" numeric, "vitamin_b1_mg" numeric, "vitamin_b2_mg" numeric, "niacin_mg" numeric, "vitamin_b6_mg" numeric, "vitamin_b12_ug" numeric, "folic_acid_ug" numeric, "pantothenic_acid_mg" numeric, "biotin_ug" numeric, "vitamin_c_mg" numeric, "salt_eq_g" numeric, "water_g" numeric, "alcohol_g" numeric, "discard_rate_percent" numeric, "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$ BEGIN PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true); PERFORM set_config('hnsw.max_scan_tuples', '20000', true); RETURN QUERY SELECT i.id, i.name, i.name_norm, i.calories_kcal, i.protein_g, i.fat_g, i.carbs_g, i.fiber_g, i.sodium_mg, i.potassium_mg, i.calcium_mg, i.magnesium_mg, i.phosphorus_mg, i.iron_mg, i.zinc_mg, i.copper_mg, i.manganese_mg, i.iodine_ug, i.selenium_ug, i.chromium_ug, i.molybdenum_ug, i.cholesterol_mg, i.vitamin_a_ug, i.vitamin_d_ug, i.vitamin_e_alpha_mg, i.vitamin_k_ug, i.vitamin_b1_mg, i.vitamin_b2_mg, i.niacin_mg, i.vitamin_b6_mg, i.vitamin_b12_ug, i.folic_acid_ug, i.pantothenic_acid_mg, i.biotin_ug, i.vitamin_c_mg, i.salt_eq_g, i.water_g, i.alcohol_g, i.discard_rate_percent, (1 - (i.name_embedding <=> query_embedding))::double precision AS similarity FROM dataset_ingredients i WHERE i.name_embedding IS NOT NULL ORDER BY i.name_embedding <=> query_embedding ASC LIMIT match_count; END; $$;


ALTER FUNCTION "public"."search_ingredients_full_by_embedding"("query_embedding" "extensions"."vector", "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_menu_examples"("query_embedding" "extensions"."vector", "match_count" integer DEFAULT 10, "filter_meal_type_hint" "text" DEFAULT NULL::"text", "filter_max_sodium" numeric DEFAULT NULL::numeric, "filter_theme_tags" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("id" "uuid", "external_id" "text", "title" "text", "theme_tags" "text"[], "meal_type_hint" "text", "dishes" "jsonb", "calories_kcal" integer, "sodium_g" numeric, "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$ BEGIN PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true); PERFORM set_config('hnsw.max_scan_tuples', '20000', true); RETURN QUERY SELECT m.id, m.external_id, m.title, m.theme_tags, m.meal_type_hint, m.dishes, m.calories_kcal, m.sodium_g, (1 - (m.content_embedding <=> query_embedding))::double precision AS similarity FROM dataset_menu_sets m WHERE m.content_embedding IS NOT NULL AND COALESCE(NULLIF(btrim(m.title), ''), '') NOT IN ('', '（無題）', '無題') AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m.dishes, '[]'::jsonb)) AS dish WHERE NULLIF(btrim(COALESCE(dish->>'name', '')), '') IS NOT NULL) AND (filter_meal_type_hint IS NULL OR m.meal_type_hint = filter_meal_type_hint) AND (filter_max_sodium IS NULL OR m.sodium_g <= filter_max_sodium) AND (filter_theme_tags IS NULL OR m.theme_tags @> filter_theme_tags) ORDER BY m.content_embedding <=> query_embedding ASC LIMIT match_count; END; $$;


ALTER FUNCTION "public"."search_menu_examples"("query_embedding" "extensions"."vector", "match_count" integer, "filter_meal_type_hint" "text", "filter_max_sodium" numeric, "filter_theme_tags" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_recipes_hybrid"("query_text" "text", "query_embedding" "extensions"."vector" DEFAULT NULL::"extensions"."vector", "match_count" integer DEFAULT 5, "similarity_threshold" numeric DEFAULT 0.15) RETURNS TABLE("id" "uuid", "external_id" "text", "name" "text", "calories_kcal" integer, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "sodium_g" numeric, "fiber_g" numeric, "ingredients_text" "text", "instructions_text" "text", "combined_score" numeric)
    LANGUAGE "plpgsql" STABLE
    AS $$ BEGIN PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true); PERFORM set_config('hnsw.max_scan_tuples', '20000', true); RETURN QUERY SELECT r.id, r.external_id, r.name, r.calories_kcal, r.protein_g, r.fat_g, r.carbs_g, r.sodium_g, r.fiber_g, r.ingredients_text, r.instructions_text, (COALESCE(similarity(r.name_norm, normalize_dish_name(query_text)), 0) * 0.4 + CASE WHEN query_embedding IS NOT NULL AND r.name_embedding IS NOT NULL THEN (1 - (r.name_embedding <=> query_embedding)) * 0.6 ELSE 0 END)::numeric AS combined_score FROM dataset_recipes r WHERE similarity(r.name_norm, normalize_dish_name(query_text)) >= similarity_threshold OR (query_embedding IS NOT NULL AND r.name_embedding IS NOT NULL AND (r.name_embedding <=> query_embedding) < 0.7) ORDER BY combined_score DESC LIMIT match_count; END; $$;


ALTER FUNCTION "public"."search_recipes_hybrid"("query_text" "text", "query_embedding" "extensions"."vector", "match_count" integer, "similarity_threshold" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric DEFAULT 0.3, "result_limit" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "name" "text", "name_norm" "text", "source_url" "text", "ingredients_text" "text", "calories_kcal" integer, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "fiber_g" numeric, "sodium_g" numeric, "potassium_mg" numeric, "calcium_mg" numeric, "phosphorus_mg" numeric, "iron_mg" numeric, "zinc_mg" numeric, "iodine_ug" numeric, "cholesterol_mg" numeric, "vitamin_a_ug" numeric, "vitamin_d_ug" numeric, "vitamin_e_mg" numeric, "vitamin_k_ug" numeric, "vitamin_b1_mg" numeric, "vitamin_b2_mg" numeric, "vitamin_b6_mg" numeric, "vitamin_b12_ug" numeric, "folic_acid_ug" numeric, "vitamin_c_mg" numeric, "saturated_fat_g" numeric, "monounsaturated_fat_g" numeric, "polyunsaturated_fat_g" numeric, "similarity" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    r.id,
    r.name,
    r.name_norm,
    r.source_url,
    r.ingredients_text,
    -- 基本栄養素
    r.calories_kcal,
    r.protein_g,
    r.fat_g,
    r.carbs_g,
    r.fiber_g,
    -- ミネラル
    r.sodium_g,
    r.potassium_mg,
    r.calcium_mg,
    r.phosphorus_mg,
    r.iron_mg,
    r.zinc_mg,
    r.iodine_ug,
    r.cholesterol_mg,
    -- ビタミン
    r.vitamin_a_ug,
    r.vitamin_d_ug,
    r.vitamin_e_mg,
    r.vitamin_k_ug,
    r.vitamin_b1_mg,
    r.vitamin_b2_mg,
    r.vitamin_b6_mg,
    r.vitamin_b12_ug,
    r.folic_acid_ug,
    r.vitamin_c_mg,
    -- 脂肪酸
    r.saturated_fat_g,
    r.monounsaturated_fat_g,
    r.polyunsaturated_fat_g,
    -- 類似度（pg_trgm）
    similarity(r.name_norm, public.normalize_dish_name(query_name)) as similarity
  FROM dataset_recipes r
  WHERE similarity(r.name_norm, public.normalize_dish_name(query_name)) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT result_limit;
$$;


ALTER FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) IS 'レシピ名のテキスト類似度検索（栄養素付き）- エビデンス検証用';



CREATE OR REPLACE FUNCTION "public"."search_similar_dataset_ingredients"("query_name" "text", "similarity_threshold" numeric DEFAULT 0.3, "result_limit" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "name" "text", "calories_kcal" numeric, "protein_g" numeric, "fat_g" numeric, "carbs_g" numeric, "salt_eq_g" numeric, "similarity" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  select
    i.id,
    i.name,
    i.calories_kcal,
    i.protein_g,
    i.fat_g,
    i.carbs_g,
    i.salt_eq_g,
    similarity(i.name_norm, public.normalize_dish_name(query_name)) as similarity
  from dataset_ingredients i
  where similarity(i.name_norm, public.normalize_dish_name(query_name)) >= similarity_threshold
  order by similarity desc
  limit result_limit;
$$;


ALTER FUNCTION "public"."search_similar_dataset_ingredients"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_similar_dataset_recipes"("query_name" "text", "similarity_threshold" numeric DEFAULT 0.3, "result_limit" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "external_id" "text", "name" "text", "similarity" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  select
    r.id,
    r.external_id,
    r.name,
    similarity(r.name_norm, normalize_dish_name(query_name)) as similarity
  from dataset_recipes r
  where similarity(r.name_norm, normalize_dish_name(query_name)) >= similarity_threshold
  order by similarity desc
  limit result_limit;
$$;


ALTER FUNCTION "public"."search_similar_dataset_recipes"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_recipe_like_count"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_recipe_uuid UUID;
  v_count INTEGER;
BEGIN
  -- INSERT または DELETE のターゲット行から recipe_uuid を取得
  IF TG_OP = 'DELETE' THEN
    v_recipe_uuid := OLD.recipe_uuid;
  ELSE
    v_recipe_uuid := NEW.recipe_uuid;
  END IF;

  -- recipe_uuid が null の場合（TEXT-only 旧行）はスキップ
  IF v_recipe_uuid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- atomic カウント更新
  SELECT COUNT(*) INTO v_count
  FROM recipe_likes
  WHERE recipe_uuid = v_recipe_uuid;

  UPDATE recipes
  SET like_count = v_count
  WHERE id = v_recipe_uuid;

  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."sync_recipe_like_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_ai_consultation_sessions_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_ai_consultation_sessions_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_embedding_jobs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_embedding_jobs_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_family_groups_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_family_groups_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_family_members_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_family_members_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_health_checkups_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_health_checkups_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_health_goals_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_health_goals_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_health_records_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_health_records_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_health_streaks_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_health_streaks_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_inquiries_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_inquiries_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_my_share_settings"("p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_member family_members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET share_meals  = p_share_meals,
        share_health = p_share_health,
        share_menu   = p_share_menu
    WHERE user_id = auth.uid() AND status = 'active'
    RETURNING * INTO v_member;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_member;
END $$;


ALTER FUNCTION "public"."update_my_share_settings"("p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_nutrition_targets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_nutrition_targets_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_performance_checkin_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_performance_checkin_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_shopping_list_requests_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_shopping_list_requests_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_daily_meal_slot"("p_user_id" "uuid", "p_day_date" "date", "p_meal_type" "text", "p_planned_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_daily_meal_id  UUID;
  v_planned_meal_id UUID;
  v_existing_id    UUID;
BEGIN
  -- 1. user_daily_meals を upsert
  INSERT INTO user_daily_meals (user_id, day_date, updated_at)
  VALUES (p_user_id, p_day_date, NOW())
  ON CONFLICT (user_id, day_date)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_daily_meal_id;

  -- 2. 既存 planned_meal を確認
  SELECT id INTO v_existing_id
  FROM planned_meals
  WHERE daily_meal_id = v_daily_meal_id
    AND meal_type = p_meal_type
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- 既存レコードを更新
    UPDATE planned_meals
    SET
      dish_name        = p_planned_data->>'dish_name',
      ingredients      = (p_planned_data->'ingredients'),
      recipe_steps     = (p_planned_data->'recipe_steps'),
      dishes           = (p_planned_data->'dishes'),
      mode             = COALESCE(p_planned_data->>'mode', 'ai_creative'),
      is_simple        = COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      display_order    = COALESCE((p_planned_data->>'display_order')::INT, 0),
      is_generating    = FALSE,
      calories_kcal    = (p_planned_data->>'calories_kcal')::NUMERIC,
      protein_g        = (p_planned_data->>'protein_g')::NUMERIC,
      fat_g            = (p_planned_data->>'fat_g')::NUMERIC,
      carbs_g          = (p_planned_data->>'carbs_g')::NUMERIC,
      sodium_g         = (p_planned_data->>'sodium_g')::NUMERIC,
      fiber_g          = (p_planned_data->>'fiber_g')::NUMERIC,
      image_url        = p_planned_data->>'image_url',
      updated_at       = NOW()
    WHERE id = v_existing_id
    RETURNING id INTO v_planned_meal_id;
  ELSE
    -- 新規挿入
    INSERT INTO planned_meals (
      daily_meal_id, meal_type, dish_name, ingredients, recipe_steps, dishes,
      mode, is_simple, display_order, is_generating, is_completed,
      calories_kcal, protein_g, fat_g, carbs_g, sodium_g, fiber_g,
      image_url, updated_at
    ) VALUES (
      v_daily_meal_id,
      p_meal_type,
      p_planned_data->>'dish_name',
      (p_planned_data->'ingredients'),
      (p_planned_data->'recipe_steps'),
      (p_planned_data->'dishes'),
      COALESCE(p_planned_data->>'mode', 'ai_creative'),
      COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      COALESCE((p_planned_data->>'display_order')::INT, 0),
      FALSE,
      FALSE,
      (p_planned_data->>'calories_kcal')::NUMERIC,
      (p_planned_data->>'protein_g')::NUMERIC,
      (p_planned_data->>'fat_g')::NUMERIC,
      (p_planned_data->>'carbs_g')::NUMERIC,
      (p_planned_data->>'sodium_g')::NUMERIC,
      (p_planned_data->>'fiber_g')::NUMERIC,
      p_planned_data->>'image_url',
      NOW()
    )
    RETURNING id INTO v_planned_meal_id;
  END IF;

  RETURN jsonb_build_object(
    'daily_meal_id',  v_daily_meal_id,
    'planned_meal_id', v_planned_meal_id,
    'outcome',        CASE WHEN v_existing_id IS NOT NULL THEN 'updated' ELSE 'inserted' END
  );
END;
$$;


ALTER FUNCTION "public"."upsert_daily_meal_slot"("p_user_id" "uuid", "p_day_date" "date", "p_meal_type" "text", "p_planned_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_has_non_sandbox_activity"() RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM meals WHERE user_id = auth.uid() AND is_sandbox = false LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM user_daily_meals WHERE user_id = auth.uid() AND is_sandbox = false LIMIT 1
  );
END;
$$;


ALTER FUNCTION "public"."user_has_non_sandbox_activity"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."user_has_non_sandbox_activity"() IS '自分のユーザーが non-sandbox の meal/user_daily_meal を持っているか判定。auth.uid() を内部で使うため引数無し、他人の情報漏洩なし。';



CREATE TABLE IF NOT EXISTS "public"."admin_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "action_type" "text" NOT NULL,
    "target_id" "uuid",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "target_type" character varying(30),
    "severity" character varying(20) DEFAULT 'info'::character varying NOT NULL,
    "impersonated_by" "uuid",
    "session_id" character varying(255),
    "ip_address" "inet",
    "user_agent" "text",
    "actor_email_snapshot" character varying(255),
    "actor_role_snapshot" character varying(50),
    CONSTRAINT "admin_audit_logs_severity_check" CHECK ((("severity")::"text" = ANY ((ARRAY['info'::character varying, 'warn'::character varying, 'critical'::character varying])::"text"[])))
);


ALTER TABLE "public"."admin_audit_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_audit_logs" IS '監査ログ。RLS により UPDATE/DELETE 完全禁止。保持期間7年(個人情報保護法/SOC2)';



CREATE TABLE IF NOT EXISTS "public"."admin_user_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "admin_id" "uuid",
    "note" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."admin_user_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_action_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid",
    "message_id" "uuid",
    "action_type" "text" NOT NULL,
    "action_params" "jsonb" NOT NULL,
    "result" "jsonb",
    "status" "text" DEFAULT 'pending'::"text",
    "executed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_action_logs_action_type_check" CHECK (("action_type" = ANY (ARRAY['generate_day_menu'::"text", 'generate_week_menu'::"text", 'create_meal'::"text", 'update_meal'::"text", 'delete_meal'::"text", 'complete_meal'::"text", 'add_to_shopping_list'::"text", 'update_shopping_item'::"text", 'delete_shopping_item'::"text", 'check_shopping_item'::"text", 'add_pantry_item'::"text", 'update_pantry_item'::"text", 'delete_pantry_item'::"text", 'suggest_recipe'::"text", 'like_recipe'::"text", 'add_recipe_to_collection'::"text", 'update_nutrition_target'::"text", 'set_health_goal'::"text", 'update_health_goal'::"text", 'delete_health_goal'::"text", 'add_health_record'::"text", 'update_health_record'::"text", 'update_profile_preferences'::"text", 'analyze_nutrition'::"text"]))),
    CONSTRAINT "ai_action_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'executed'::"text", 'rejected'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."ai_action_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_consultation_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid",
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "metadata" "jsonb",
    "proposed_actions" "jsonb",
    "tokens_used" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_important" boolean DEFAULT false,
    "importance_reason" "text",
    CONSTRAINT "ai_consultation_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."ai_consultation_messages" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ai_consultation_messages"."is_important" IS 'ユーザーがマークした重要なメッセージ';



COMMENT ON COLUMN "public"."ai_consultation_messages"."importance_reason" IS '重要とマークした理由';



CREATE TABLE IF NOT EXISTS "public"."ai_consultation_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "title" "text" DEFAULT 'AI相談'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "summary" "text",
    "context_snapshot" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "summary_generated_at" timestamp with time zone,
    "key_topics" "text"[],
    "action_history" "jsonb" DEFAULT '[]'::"jsonb",
    CONSTRAINT "ai_consultation_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."ai_consultation_sessions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ai_consultation_sessions"."summary" IS 'AIが生成したセッションの要約';



COMMENT ON COLUMN "public"."ai_consultation_sessions"."key_topics" IS 'セッションで話された主要トピック';



COMMENT ON COLUMN "public"."ai_consultation_sessions"."action_history" IS '実行されたアクションの履歴';



CREATE TABLE IF NOT EXISTS "public"."ai_content_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "content_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "input_prompt" "text",
    "output_content" "text",
    "model_name" "text",
    "tokens_used" integer,
    "cost_usd" numeric(10,6),
    "flagged" boolean DEFAULT false,
    "flag_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_content_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."announcement_reads" (
    "user_id" "uuid" NOT NULL,
    "announcement_id" "uuid" NOT NULL,
    "read_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."announcement_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."announcements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "is_public" boolean DEFAULT false,
    "published_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "category" "text" DEFAULT 'general'::"text",
    "priority" integer DEFAULT 0,
    "target_audience" "text" DEFAULT 'all'::"text",
    "expires_at" timestamp with time zone,
    "image_url" "text"
);


ALTER TABLE "public"."announcements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "level" "text" DEFAULT 'info'::"text" NOT NULL,
    "source" "text" NOT NULL,
    "function_name" "text",
    "user_id" "uuid",
    "message" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "error_message" "text",
    "error_stack" "text",
    "request_id" "text"
);


ALTER TABLE "public"."app_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."app_logs" IS 'アプリケーションログ - Edge Functions、API Routes、クライアントからのログを保存';



CREATE TABLE IF NOT EXISTS "public"."badges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "condition_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "metric_code" "text",
    "icon" "text",
    "priority" integer DEFAULT 100
);


ALTER TABLE "public"."badges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blood_test_longitudinal_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "review_date" "date" DEFAULT CURRENT_DATE,
    "blood_test_ids" "uuid"[] NOT NULL,
    "trend_analysis" "jsonb",
    "nutrition_guidance" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."blood_test_longitudinal_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blood_test_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "test_date" "date" NOT NULL,
    "test_facility" "text",
    "total_cholesterol" integer,
    "ldl_cholesterol" integer,
    "hdl_cholesterol" integer,
    "triglycerides" integer,
    "fasting_glucose" integer,
    "hba1c" numeric(3,1),
    "ast" integer,
    "alt" integer,
    "gamma_gtp" integer,
    "creatinine" numeric(4,2),
    "egfr" numeric(5,1),
    "uric_acid" numeric(3,1),
    "bun" numeric(4,1),
    "hemoglobin" numeric(3,1),
    "hematocrit" numeric(4,1),
    "rbc" numeric(4,1),
    "wbc" integer,
    "platelets" numeric(4,1),
    "albumin" numeric(3,1),
    "total_protein" numeric(3,1),
    "total_bilirubin" numeric(3,1),
    "other_results" "jsonb",
    "note" "text",
    "report_image_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "ai_review" "jsonb"
);


ALTER TABLE "public"."blood_test_results" OWNER TO "postgres";


COMMENT ON TABLE "public"."blood_test_results" IS '血液検査結果（健康診断データ）';



CREATE TABLE IF NOT EXISTS "public"."buddies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id_1" "uuid",
    "user_id_2" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."buddies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."buddy_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_user_id" "uuid",
    "to_user_id" "uuid",
    "action_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."buddy_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."catalog_import_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "trigger_type" "text" DEFAULT 'manual'::"text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "source_code" "text" NOT NULL,
    "category_code" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "categories_total" integer DEFAULT 0 NOT NULL,
    "pages_total" integer DEFAULT 0 NOT NULL,
    "products_seen" integer DEFAULT 0 NOT NULL,
    "products_inserted" integer DEFAULT 0 NOT NULL,
    "products_updated" integer DEFAULT 0 NOT NULL,
    "products_unchanged" integer DEFAULT 0 NOT NULL,
    "products_discontinued" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "metadata_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_log" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "catalog_import_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'partial'::"text"]))),
    CONSTRAINT "catalog_import_runs_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['manual'::"text", 'scheduled'::"text", 'backfill'::"text"])))
);


ALTER TABLE "public"."catalog_import_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_import_runs" IS 'Firecrawl + LLM 正規化の取り込み実行履歴';



CREATE TABLE IF NOT EXISTS "public"."catalog_product_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "import_run_id" "uuid",
    "snapshot_hash" "text" NOT NULL,
    "name" "text" NOT NULL,
    "price_yen" numeric,
    "main_image_url" "text",
    "availability_status" "text",
    "calories_kcal" numeric,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "fiber_g" numeric,
    "sodium_g" numeric,
    "sugar_g" numeric,
    "nutrition_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "allergens_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metadata_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."catalog_product_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_product_snapshots" IS '商品内容の差分履歴';



CREATE TABLE IF NOT EXISTS "public"."catalog_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "external_id" "text" NOT NULL,
    "canonical_url" "text" NOT NULL,
    "name" "text" NOT NULL,
    "name_norm" "text" NOT NULL,
    "brand_name" "text" NOT NULL,
    "category_code" "text",
    "subcategory_code" "text",
    "description" "text",
    "price_yen" numeric,
    "sales_region" "text",
    "availability_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "main_image_url" "text",
    "calories_kcal" numeric,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "fiber_g" numeric,
    "sodium_g" numeric,
    "sugar_g" numeric,
    "nutrition_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "allergens_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metadata_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone,
    "discontinued_at" timestamp with time zone,
    "content_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "catalog_products_availability_status_check" CHECK (("availability_status" = ANY (ARRAY['active'::"text", 'limited'::"text", 'discontinued'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."catalog_products" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_products" IS '市販商品の正本テーブル（現行状態）';



CREATE TABLE IF NOT EXISTS "public"."catalog_raw_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "import_run_id" "uuid",
    "category_code" "text",
    "document_type" "text" NOT NULL,
    "url" "text" NOT NULL,
    "http_status" integer,
    "content_sha256" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "catalog_raw_documents_document_type_check" CHECK (("document_type" = ANY (ARRAY['list'::"text", 'detail'::"text"])))
);


ALTER TABLE "public"."catalog_raw_documents" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_raw_documents" IS 'Firecrawl取得結果の生データ保存';



CREATE TABLE IF NOT EXISTS "public"."catalog_source_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "category_code" "text" NOT NULL,
    "category_name" "text" NOT NULL,
    "list_url" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "crawl_priority" integer DEFAULT 100 NOT NULL,
    "metadata_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_crawled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."catalog_source_categories" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_source_categories" IS '取得元ごとのカテゴリ一覧';



CREATE TABLE IF NOT EXISTS "public"."catalog_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "brand_name" "text" NOT NULL,
    "country_code" "text" DEFAULT 'JP'::"text" NOT NULL,
    "base_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "crawl_interval_minutes" integer DEFAULT 720 NOT NULL,
    "rate_limit_per_minute" integer DEFAULT 12 NOT NULL,
    "metadata_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."catalog_sources" OWNER TO "postgres";


COMMENT ON TABLE "public"."catalog_sources" IS 'コンビニ・市販商品カタログの取得元マスタ';



CREATE TABLE IF NOT EXISTS "public"."cookie_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "session_id" character varying(255),
    "analytics" boolean DEFAULT false NOT NULL,
    "advertising" boolean DEFAULT false NOT NULL,
    "consented_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "inet",
    "user_agent" "text"
);


ALTER TABLE "public"."cookie_consents" OWNER TO "postgres";


COMMENT ON TABLE "public"."cookie_consents" IS 'Cookie 同意記録。改正電気通信事業法準拠。未ログイン時は user_id=NULL。';



CREATE TABLE IF NOT EXISTS "public"."coupon_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "organization_id" "uuid",
    "subscription_target" character varying(20) NOT NULL,
    "applied_to_subscription_id" "uuid" NOT NULL,
    "discount_amount_jpy" integer NOT NULL,
    "duration_months" integer,
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "end_reason" character varying(50),
    "applied_retroactively" boolean DEFAULT false NOT NULL,
    "approved_by" "uuid",
    CONSTRAINT "coupon_redemptions_subscription_target_check" CHECK ((("subscription_target")::"text" = ANY ((ARRAY['personal'::character varying, 'org'::character varying])::"text"[]))),
    CONSTRAINT "coupon_redemptions_user_or_org" CHECK ((("user_id" IS NOT NULL) OR ("organization_id" IS NOT NULL)))
);


ALTER TABLE "public"."coupon_redemptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."coupon_redemptions" IS 'クーポン適用履歴。1契約に有効なredemptionは1件のみ。';



CREATE TABLE IF NOT EXISTS "public"."coupons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" character varying(50) NOT NULL,
    "display_name" character varying(200),
    "discount_type" character varying(20) NOT NULL,
    "discount_value" numeric NOT NULL,
    "applicable_plans" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "applicable_to" character varying(20) DEFAULT 'all'::character varying NOT NULL,
    "valid_from" timestamp with time zone NOT NULL,
    "valid_until" timestamp with time zone NOT NULL,
    "max_uses" integer,
    "uses_count" integer DEFAULT 0 NOT NULL,
    "per_user_limit" integer DEFAULT 1 NOT NULL,
    "duration_months" integer,
    "gross_margin_preview_jpy" integer,
    "status" character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coupons_applicable_to_check" CHECK ((("applicable_to")::"text" = ANY ((ARRAY['all'::character varying, 'personal'::character varying, 'family'::character varying, 'org'::character varying])::"text"[]))),
    CONSTRAINT "coupons_discount_type_check" CHECK ((("discount_type")::"text" = ANY ((ARRAY['fixed'::character varying, 'percentage'::character varying])::"text"[]))),
    CONSTRAINT "coupons_discount_value_positive" CHECK (("discount_value" > (0)::numeric)),
    CONSTRAINT "coupons_percentage_max" CHECK (((("discount_type")::"text" <> 'percentage'::"text") OR ("discount_value" <= (100)::numeric))),
    CONSTRAINT "coupons_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'expired'::character varying])::"text"[])))
);


ALTER TABLE "public"."coupons" OWNER TO "postgres";


COMMENT ON TABLE "public"."coupons" IS 'クーポン・割引コード管理。';



CREATE TABLE IF NOT EXISTS "public"."csat_feedbacks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticket_id" "uuid",
    "score" integer NOT NULL,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "csat_feedbacks_score_check" CHECK ((("score" >= 1) AND ("score" <= 5)))
);


ALTER TABLE "public"."csat_feedbacks" OWNER TO "postgres";


COMMENT ON TABLE "public"."csat_feedbacks" IS 'CSAT フィードバック。スコア 1-5。サポートチケット紐付け。';



CREATE TABLE IF NOT EXISTS "public"."daily_active_users" (
    "date" "date" NOT NULL,
    "plan_type" character varying(20) NOT NULL,
    "plan_key" character varying(100) DEFAULT ''::character varying NOT NULL,
    "dau" integer DEFAULT 0 NOT NULL,
    "wau" integer DEFAULT 0 NOT NULL,
    "mau" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "daily_active_users_plan_type_check" CHECK ((("plan_type")::"text" = ANY ((ARRAY['personal'::character varying, 'family'::character varying, 'org'::character varying, 'all'::character varying])::"text"[])))
);


ALTER TABLE "public"."daily_active_users" OWNER TO "postgres";


COMMENT ON TABLE "public"."daily_active_users" IS '日次アクティブユーザー集計。全体集計行は plan_key=空文字。';



CREATE TABLE IF NOT EXISTS "public"."daily_activity_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "date" "date" NOT NULL,
    "steps" integer,
    "calories_burned" integer,
    "feeling" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."daily_activity_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dataset_import_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dataset_version" "text" NOT NULL,
    "source" "text",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "menu_sets_total" integer DEFAULT 0,
    "recipes_total" integer DEFAULT 0,
    "menu_sets_inserted" integer DEFAULT 0,
    "recipes_inserted" integer DEFAULT 0,
    "notes" "text",
    "error_log" "text",
    "ingredients_total" integer DEFAULT 0,
    "ingredients_inserted" integer DEFAULT 0
);


ALTER TABLE "public"."dataset_import_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dataset_ingredients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "name_norm" "text" NOT NULL,
    "discard_rate_percent" numeric,
    "notes" "text",
    "calories_kcal" numeric,
    "water_g" numeric,
    "protein_aa_g" numeric,
    "protein_g" numeric,
    "fat_fa_tg_g" numeric,
    "cholesterol_mg" numeric,
    "fat_g" numeric,
    "available_carbs_mono_eq_g" numeric,
    "available_carbs_mass_g" numeric,
    "available_carbs_diff_g" numeric,
    "fiber_g" numeric,
    "sugar_alcohol_g" numeric,
    "carbs_g" numeric,
    "organic_acid_g" numeric,
    "ash_g" numeric,
    "sodium_mg" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "magnesium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "copper_mg" numeric,
    "manganese_mg" numeric,
    "iodine_ug" numeric,
    "selenium_ug" numeric,
    "chromium_ug" numeric,
    "molybdenum_ug" numeric,
    "vitamin_a_retinol_ug" numeric,
    "vitamin_a_alpha_carotene_ug" numeric,
    "vitamin_a_beta_carotene_ug" numeric,
    "vitamin_a_beta_cryptoxanthin_ug" numeric,
    "vitamin_a_beta_carotene_eq_ug" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_e_alpha_mg" numeric,
    "vitamin_e_beta_mg" numeric,
    "vitamin_e_gamma_mg" numeric,
    "vitamin_e_delta_mg" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "niacin_mg" numeric,
    "niacin_eq_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "pantothenic_acid_mg" numeric,
    "biotin_ug" numeric,
    "vitamin_c_mg" numeric,
    "alcohol_g" numeric,
    "salt_eq_g" numeric,
    "name_embedding" "extensions"."vector"(1024),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dataset_ingredients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dataset_menu_sets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "external_id" "text" NOT NULL,
    "source_url" "text",
    "title" "text" NOT NULL,
    "theme_raw" "text",
    "theme_tags" "text"[],
    "meal_type_hint" "text",
    "dish_count" integer DEFAULT 0 NOT NULL,
    "dishes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "calories_kcal" integer,
    "sodium_g" numeric,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "sugar_g" numeric,
    "fiber_g" numeric,
    "fiber_soluble_g" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "magnesium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "iodine_ug" numeric,
    "cholesterol_mg" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "vitamin_c_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_e_mg" numeric,
    "saturated_fat_g" numeric,
    "monounsaturated_fat_g" numeric,
    "polyunsaturated_fat_g" numeric,
    "content_embedding" "extensions"."vector"(1024),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dataset_menu_sets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dataset_recipes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "external_id" "text" NOT NULL,
    "source_url" "text",
    "name" "text" NOT NULL,
    "name_norm" "text" NOT NULL,
    "target_audience_raw" "text",
    "tag_raw" "text",
    "ingredients_text" "text",
    "instructions_text" "text",
    "calories_kcal" integer,
    "sodium_g" numeric,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "sugar_g" numeric,
    "fiber_g" numeric,
    "fiber_soluble_g" numeric,
    "fiber_insoluble_g" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "iodine_ug" numeric,
    "cholesterol_mg" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "vitamin_c_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_e_mg" numeric,
    "saturated_fat_g" numeric,
    "monounsaturated_fat_g" numeric,
    "polyunsaturated_fat_g" numeric,
    "name_embedding" "extensions"."vector"(1024),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dataset_recipes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "manager_id" "uuid",
    "display_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."derived_recipes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "name_norm" "text" NOT NULL,
    "base_dataset_recipe_id" "uuid" NOT NULL,
    "base_dataset_recipe_external_id" "text",
    "created_by_user_id" "uuid",
    "source_dataset_version" "text",
    "derived_from_menu_set_external_id" "text",
    "generator" "text" DEFAULT 'ai'::"text" NOT NULL,
    "generation_metadata" "jsonb",
    "servings" integer DEFAULT 1 NOT NULL,
    "ingredients" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "instructions" "text"[],
    "calories_kcal" integer,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "sodium_g" numeric,
    "sugar_g" numeric,
    "fiber_g" numeric,
    "fiber_soluble_g" numeric,
    "fiber_insoluble_g" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "iodine_ug" numeric,
    "cholesterol_mg" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "vitamin_c_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_e_mg" numeric,
    "saturated_fat_g" numeric,
    "monounsaturated_fat_g" numeric,
    "polyunsaturated_fat_g" numeric,
    "name_embedding" "extensions"."vector"(1024),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "magnesium_mg" numeric
);


ALTER TABLE "public"."derived_recipes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_blacklist" (
    "email" character varying(255) NOT NULL,
    "reason" character varying(50) NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid",
    CONSTRAINT "email_blacklist_reason_check" CHECK ((("reason")::"text" = ANY ((ARRAY['bounce'::character varying, 'complaint'::character varying, 'manual'::character varying])::"text"[])))
);


ALTER TABLE "public"."email_blacklist" OWNER TO "postgres";


COMMENT ON TABLE "public"."email_blacklist" IS 'メールブラックリスト。バウンス・苦情で自動追加。';



CREATE TABLE IF NOT EXISTS "public"."email_delivery_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "email" character varying(255) NOT NULL,
    "template" character varying(100),
    "resend_message_id" character varying(255),
    "status" character varying(20) DEFAULT 'sent'::character varying NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_delivery_logs_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['sent'::character varying, 'delivered'::character varying, 'bounced'::character varying, 'complained'::character varying, 'opened'::character varying, 'clicked'::character varying])::"text"[])))
);


ALTER TABLE "public"."email_delivery_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."email_delivery_logs" IS 'メール配信ログ。Resend との連携ログ。';



CREATE TABLE IF NOT EXISTS "public"."embedding_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'idle'::"text" NOT NULL,
    "table_name" "text" NOT NULL,
    "model" "text" NOT NULL,
    "dimensions" integer NOT NULL,
    "start_offset" integer DEFAULT 0,
    "current_offset" integer DEFAULT 0,
    "total_processed" integer DEFAULT 0,
    "total_count" integer DEFAULT 0,
    "percentage" numeric(5,2) DEFAULT 0,
    "start_time" timestamp with time zone,
    "elapsed_minutes" numeric(10,1),
    "completed_at" timestamp with time zone,
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."embedding_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."embedding_jobs" IS '埋め込み再生成ジョブの進捗を保存';



CREATE TABLE IF NOT EXISTS "public"."experiment_assignments" (
    "experiment_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "variant_key" character varying(50) NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."experiment_assignments" OWNER TO "postgres";


COMMENT ON TABLE "public"."experiment_assignments" IS 'A/Bテストユーザー割り当て。';



CREATE TABLE IF NOT EXISTS "public"."experiments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" character varying(100) NOT NULL,
    "name" character varying(200) NOT NULL,
    "hypothesis" "text",
    "variants" "jsonb" NOT NULL,
    "primary_metric" character varying(100),
    "start_date" "date",
    "end_date" "date",
    "status" character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    "result" "jsonb",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiments_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['draft'::character varying, 'running'::character varying, 'completed'::character varying, 'cancelled'::character varying])::"text"[])))
);


ALTER TABLE "public"."experiments" OWNER TO "postgres";


COMMENT ON TABLE "public"."experiments" IS 'A/Bテスト実験定義。';



CREATE TABLE IF NOT EXISTS "public"."external_data_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" character varying(50) NOT NULL,
    "consented" boolean NOT NULL,
    "consented_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "revoked_at" timestamp with time zone,
    CONSTRAINT "external_data_consents_provider_check" CHECK ((("provider")::"text" = ANY ((ARRAY['xai'::character varying, 'anthropic'::character varying, 'google'::character varying, 'openai'::character varying])::"text"[])))
);


ALTER TABLE "public"."external_data_consents" OWNER TO "postgres";


COMMENT ON TABLE "public"."external_data_consents" IS '外国第三者提供同意 (個人情報保護法24条)。xAI/Anthropic/Google/OpenAI。';



CREATE TABLE IF NOT EXISTS "public"."failed_invite_lookups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ip_address" "inet" NOT NULL,
    "token_hint" character varying(10),
    "invite_type" character varying(20),
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "failed_invite_lookups_invite_type_check" CHECK ((("invite_type")::"text" = ANY ((ARRAY['family'::character varying, 'org'::character varying])::"text"[])))
);


ALTER TABLE "public"."failed_invite_lookups" OWNER TO "postgres";


COMMENT ON TABLE "public"."failed_invite_lookups" IS '招待トークン総当たり攻撃検知・レート制限用。7日超は pg_cron で削除。';



CREATE TABLE IF NOT EXISTS "public"."family_meal_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "planned_meal_id" "uuid",
    "family_member_id" "uuid",
    "portion_ratio" numeric DEFAULT 1.0,
    "is_completed" boolean DEFAULT false,
    "completed_at" timestamp with time zone,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."family_meal_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" character varying(100) NOT NULL,
    "description" "text",
    "enabled" boolean DEFAULT false NOT NULL,
    "rollout_strategy" "jsonb",
    "constraints" "jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."feature_flags" OWNER TO "postgres";


COMMENT ON TABLE "public"."feature_flags" IS '機能フラグ定義。enabled/rollout_strategy/constraints は super-admin API (PATCH) から実更新され、
   evaluateFlag (src/lib/super-admin/evaluate-flag.ts) がユーザーコンテキストに対し実判定する。
   feature_packages.feature_flags (VARCHAR配列) とは別概念 — そちらは「パッケージが含むフラグキー一覧」。';



CREATE TABLE IF NOT EXISTS "public"."feature_packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "package_key" character varying(100) NOT NULL,
    "display_name" character varying(200) NOT NULL,
    "description" "text",
    "feature_flags" character varying(100)[] DEFAULT '{}'::character varying[] NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "status" character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "feature_packages_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['active'::character varying, 'deprecated'::character varying])::"text"[])))
);


ALTER TABLE "public"."feature_packages" OWNER TO "postgres";


COMMENT ON TABLE "public"."feature_packages" IS '機能パッケージ定義。subscription_plans.feature_packages 配列から参照される。';



CREATE TABLE IF NOT EXISTS "public"."gdpr_deletion_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cooling_until" timestamp with time zone DEFAULT ("now"() + '30 days'::interval) NOT NULL,
    "cancelled_at" timestamp with time zone,
    "executed_at" timestamp with time zone,
    "certificate_url" "text",
    "executed_by" "uuid",
    "notes" "text"
);


ALTER TABLE "public"."gdpr_deletion_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."gdpr_deletion_requests" IS 'GDPR/個人情報消去リクエスト。30日クーリングオフ後実行。';



CREATE TABLE IF NOT EXISTS "public"."health_challenges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "challenge_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "target_metric" "text" NOT NULL,
    "target_value" numeric(10,2) NOT NULL,
    "target_unit" "text" NOT NULL,
    "current_value" numeric(10,2) DEFAULT 0,
    "daily_progress" "jsonb",
    "reward_points" integer,
    "reward_badge" "text",
    "reward_description" "text",
    "status" "text" DEFAULT 'active'::"text",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_challenges_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."health_challenges" OWNER TO "postgres";


COMMENT ON TABLE "public"."health_challenges" IS '週間・月間チャレンジ（ゲーミフィケーション）';



CREATE TABLE IF NOT EXISTS "public"."health_checkup_longitudinal_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "review_date" "date" DEFAULT CURRENT_DATE,
    "checkup_ids" "uuid"[] NOT NULL,
    "trend_analysis" "jsonb",
    "nutrition_guidance" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."health_checkup_longitudinal_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."health_checkups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "checkup_date" "date" NOT NULL,
    "facility_name" "text",
    "checkup_type" "text",
    "height" numeric,
    "weight" numeric,
    "bmi" numeric,
    "waist_circumference" numeric,
    "blood_pressure_systolic" integer,
    "blood_pressure_diastolic" integer,
    "hemoglobin" numeric,
    "hba1c" numeric,
    "fasting_glucose" integer,
    "total_cholesterol" integer,
    "ldl_cholesterol" integer,
    "hdl_cholesterol" integer,
    "triglycerides" integer,
    "ast" integer,
    "alt" integer,
    "gamma_gtp" integer,
    "creatinine" numeric,
    "egfr" numeric,
    "uric_acid" numeric,
    "image_url" "text",
    "individual_review" "jsonb",
    "ocr_extracted_data" "jsonb",
    "ocr_extraction_timestamp" timestamp with time zone,
    "ocr_model_used" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."health_checkups" OWNER TO "postgres";


COMMENT ON COLUMN "public"."health_checkups"."ocr_extracted_data" IS 'AI extracted raw data';



COMMENT ON COLUMN "public"."health_checkups"."ocr_extraction_timestamp" IS 'photo analysis time';



COMMENT ON COLUMN "public"."health_checkups"."ocr_model_used" IS 'AI model used';



CREATE TABLE IF NOT EXISTS "public"."health_goals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "goal_type" "text" NOT NULL,
    "target_value" numeric(10,2) NOT NULL,
    "target_unit" "text" NOT NULL,
    "start_value" numeric(10,2),
    "start_date" "date" DEFAULT CURRENT_DATE,
    "target_date" "date",
    "current_value" numeric(10,2),
    "progress_percentage" numeric(5,2),
    "last_updated_at" timestamp with time zone,
    "milestones" "jsonb",
    "status" "text" DEFAULT 'active'::"text",
    "achieved_at" timestamp with time zone,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_goals_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'achieved'::"text", 'paused'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."health_goals" OWNER TO "postgres";


COMMENT ON TABLE "public"."health_goals" IS '健康目標（体重目標、体脂肪率目標など）';



CREATE TABLE IF NOT EXISTS "public"."health_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "analysis_date" "date" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "period_type" "text" NOT NULL,
    "insight_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "details" "jsonb",
    "confidence_score" numeric(3,2),
    "recommendations" "text"[],
    "applied_to_meal_plan" boolean DEFAULT false,
    "priority" "text" DEFAULT 'medium'::"text",
    "is_alert" boolean DEFAULT false,
    "is_read" boolean DEFAULT false,
    "is_dismissed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_insights_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."health_insights" OWNER TO "postgres";


COMMENT ON TABLE "public"."health_insights" IS 'AI分析結果（体重トレンド、血圧パターン、相関分析など）';



CREATE TABLE IF NOT EXISTS "public"."health_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "record_date" "date" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"(),
    "weight" numeric(5,2),
    "body_fat_percentage" numeric(4,1),
    "muscle_mass" numeric(5,2),
    "visceral_fat_level" integer,
    "basal_metabolism" integer,
    "body_water_percentage" numeric(4,1),
    "bone_mass" numeric(4,2),
    "systolic_bp" integer,
    "diastolic_bp" integer,
    "heart_rate" integer,
    "fasting_glucose" integer,
    "postprandial_glucose" integer,
    "glucose_timing" "text",
    "body_temp" numeric(3,1),
    "waist_circumference" numeric(5,1),
    "hip_circumference" numeric(5,1),
    "sleep_hours" numeric(3,1),
    "sleep_quality" integer,
    "bedtime" time without time zone,
    "wake_time" time without time zone,
    "exercise_type" "text"[],
    "exercise_minutes" integer,
    "step_count" integer,
    "water_intake" integer,
    "bowel_movement" integer,
    "stool_type" integer,
    "overall_condition" integer,
    "energy_level" integer,
    "stress_level" integer,
    "mood_score" integer,
    "swelling" "text",
    "skin_condition" integer,
    "symptoms" "text"[],
    "menstrual_day" integer,
    "menstrual_flow" "text",
    "pms_symptoms" "text"[],
    "daily_note" "text",
    "tags" "text"[],
    "data_source" "text" DEFAULT 'manual'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_records_energy_level_check" CHECK ((("energy_level" >= 1) AND ("energy_level" <= 5))),
    CONSTRAINT "health_records_menstrual_flow_check" CHECK (("menstrual_flow" = ANY (ARRAY['light'::"text", 'medium'::"text", 'heavy'::"text"]))),
    CONSTRAINT "health_records_mood_score_check" CHECK ((("mood_score" >= 1) AND ("mood_score" <= 5))),
    CONSTRAINT "health_records_overall_condition_check" CHECK ((("overall_condition" >= 1) AND ("overall_condition" <= 5))),
    CONSTRAINT "health_records_skin_condition_check" CHECK ((("skin_condition" >= 1) AND ("skin_condition" <= 5))),
    CONSTRAINT "health_records_sleep_quality_check" CHECK ((("sleep_quality" >= 1) AND ("sleep_quality" <= 5))),
    CONSTRAINT "health_records_stool_type_check" CHECK ((("stool_type" >= 1) AND ("stool_type" <= 7))),
    CONSTRAINT "health_records_stress_level_check" CHECK ((("stress_level" >= 1) AND ("stress_level" <= 5))),
    CONSTRAINT "health_records_swelling_check" CHECK (("swelling" = ANY (ARRAY['none'::"text", 'mild'::"text", 'moderate'::"text", 'severe'::"text"])))
);


ALTER TABLE "public"."health_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."health_records" IS '日々の健康記録（体重、血圧、睡眠、体調など）';



CREATE TABLE IF NOT EXISTS "public"."health_streaks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "streak_type" "text" NOT NULL,
    "current_streak" integer DEFAULT 0,
    "longest_streak" integer DEFAULT 0,
    "last_activity_date" "date",
    "streak_start_date" "date",
    "achieved_badges" "text"[],
    "total_records" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."health_streaks" OWNER TO "postgres";


COMMENT ON TABLE "public"."health_streaks" IS '連続記録カウンター（モチベーション維持用）';



CREATE TABLE IF NOT EXISTS "public"."help_articles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" character varying(200) NOT NULL,
    "title" character varying(500) NOT NULL,
    "body" "text" NOT NULL,
    "category" character varying(100),
    "tags" character varying(50)[] DEFAULT '{}'::character varying[],
    "status" character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    "locale" character varying(5) DEFAULT 'ja'::character varying NOT NULL,
    "view_count" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "help_articles_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'archived'::character varying])::"text"[])))
);


ALTER TABLE "public"."help_articles" OWNER TO "postgres";


COMMENT ON TABLE "public"."help_articles" IS 'ヘルプ記事。published のみ一般公開。';



CREATE TABLE IF NOT EXISTS "public"."infra_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "metric_name" character varying(100) NOT NULL,
    "threshold" numeric NOT NULL,
    "comparison" character varying(10) NOT NULL,
    "triggered_at" timestamp with time zone NOT NULL,
    "resolved_at" timestamp with time zone,
    "details" "jsonb",
    "ack_by" "uuid",
    "ack_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "infra_alerts_comparison_check" CHECK ((("comparison")::"text" = ANY ((ARRAY['>'::character varying, '>='::character varying, '<'::character varying, '<='::character varying, '='::character varying])::"text"[])))
);


ALTER TABLE "public"."infra_alerts" OWNER TO "postgres";


COMMENT ON TABLE "public"."infra_alerts" IS 'インフラアラート。';



CREATE TABLE IF NOT EXISTS "public"."infra_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "metric_name" character varying(100) NOT NULL,
    "source" character varying(50) NOT NULL,
    "value" numeric NOT NULL,
    "unit" character varying(20),
    "tags" "jsonb" DEFAULT '{}'::"jsonb",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "infra_metrics_source_check" CHECK ((("source")::"text" = ANY ((ARRAY['vercel'::character varying, 'supabase'::character varying, 'gemini'::character varying, 'xai'::character varying, 'anthropic'::character varying, 'openai'::character varying, 'custom'::character varying])::"text"[])))
);


ALTER TABLE "public"."infra_metrics" OWNER TO "postgres";


COMMENT ON TABLE "public"."infra_metrics" IS 'インフラメトリクス。30日超は pg_cron で削除。';



CREATE TABLE IF NOT EXISTS "public"."ingredient_match_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "input_name" "text" NOT NULL,
    "matched_ingredient_id" "uuid",
    "match_method" "text" DEFAULT 'llm'::"text" NOT NULL,
    "similarity" numeric(5,4),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ingredient_match_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inquiries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "inquiry_type" "text" NOT NULL,
    "email" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "admin_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "resolved_at" timestamp with time zone,
    CONSTRAINT "inquiries_inquiry_type_check" CHECK (("inquiry_type" = ANY (ARRAY['general'::"text", 'support'::"text", 'bug'::"text", 'feature'::"text"]))),
    CONSTRAINT "inquiries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_progress'::"text", 'resolved'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."inquiries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."iroca_calibration_shots" (
    "id" bigint NOT NULL,
    "sample_name" "text" NOT NULL,
    "angles_deg" "jsonb",
    "visual_labs" "jsonb",
    "ccm_residual" "jsonb",
    "shot_metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."iroca_calibration_shots" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."iroca_calibration_shots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."iroca_calibration_shots_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."iroca_calibration_shots_id_seq" OWNED BY "public"."iroca_calibration_shots"."id";



CREATE TABLE IF NOT EXISTS "public"."iroca_correction_model" (
    "id" bigint NOT NULL,
    "model" "jsonb" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."iroca_correction_model" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."iroca_correction_model_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."iroca_correction_model_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."iroca_correction_model_id_seq" OWNED BY "public"."iroca_correction_model"."id";



CREATE TABLE IF NOT EXISTS "public"."iroca_experiment_plan" (
    "id" "text" NOT NULL,
    "seq_no" integer NOT NULL,
    "phase" "text" NOT NULL,
    "drug" "text" NOT NULL,
    "ratio" "text",
    "hair_type" "text" NOT NULL,
    "purpose" "text",
    "recipe_name" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "notes" "text"
);


ALTER TABLE "public"."iroca_experiment_plan" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."iroca_measurements" (
    "id" bigint NOT NULL,
    "sample_name" "text" NOT NULL,
    "meas_index" integer DEFAULT 1 NOT NULL,
    "m0_spectrum" double precision[] NOT NULL,
    "m1_spectrum" double precision[],
    "m2_spectrum" double precision[],
    "lab_l" double precision,
    "lab_a" double precision,
    "lab_b" double precision,
    "srgb_r" integer,
    "srgb_g" integer,
    "srgb_b" integer,
    "hex_color" "text",
    "delta_e_m0m1" double precision,
    "device_serial" "text",
    "notes" "text",
    "raw_xml" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."iroca_measurements" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."iroca_measurements_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."iroca_measurements_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."iroca_measurements_id_seq" OWNED BY "public"."iroca_measurements"."id";



CREATE TABLE IF NOT EXISTS "public"."iroca_sample_summary" (
    "id" bigint NOT NULL,
    "sample_name" "text" NOT NULL,
    "median_spectrum" double precision[],
    "median_lab_l" double precision,
    "median_lab_a" double precision,
    "median_lab_b" double precision,
    "srgb_r" integer,
    "srgb_g" integer,
    "srgb_b" integer,
    "hex_color" "text",
    "measurement_count" integer DEFAULT 0,
    "notes" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."iroca_sample_summary" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."iroca_sample_summary_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."iroca_sample_summary_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."iroca_sample_summary_id_seq" OWNED BY "public"."iroca_sample_summary"."id";



CREATE TABLE IF NOT EXISTS "public"."legacy_family_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "name" "text" DEFAULT '我が家'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."legacy_family_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legacy_family_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_group_id" "uuid",
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "relation" "text" NOT NULL,
    "birth_date" "date",
    "gender" "text",
    "height" numeric,
    "weight" numeric,
    "allergies" "text"[] DEFAULT '{}'::"text"[],
    "dislikes" "text"[] DEFAULT '{}'::"text"[],
    "diet_style" "text" DEFAULT 'normal'::"text",
    "health_conditions" "text"[] DEFAULT '{}'::"text"[],
    "favorite_foods" "text"[] DEFAULT '{}'::"text"[],
    "spice_tolerance" "text" DEFAULT 'medium'::"text",
    "daily_calories" integer,
    "protein_ratio" numeric,
    "is_active" boolean DEFAULT true,
    "display_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "family_members_gender_check" CHECK (("gender" = ANY (ARRAY['male'::"text", 'female'::"text", 'other'::"text"]))),
    CONSTRAINT "family_members_relation_check" CHECK (("relation" = ANY (ARRAY['self'::"text", 'spouse'::"text", 'child'::"text", 'parent'::"text", 'grandparent'::"text", 'sibling'::"text", 'other'::"text"]))),
    CONSTRAINT "family_members_spice_tolerance_check" CHECK (("spice_tolerance" = ANY (ARRAY['none'::"text", 'mild'::"text", 'medium'::"text", 'hot'::"text"])))
);


ALTER TABLE "public"."legacy_family_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_usage_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "function_name" "text" NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "request_id" "text",
    "user_id" "uuid",
    "provider" "text" DEFAULT 'openai'::"text" NOT NULL,
    "endpoint" "text" NOT NULL,
    "model" "text" NOT NULL,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "estimated_cost_usd" numeric(10,6),
    "call_type" "text",
    "duration_ms" integer,
    "success" boolean DEFAULT true NOT NULL,
    "status_code" integer,
    "openai_response_id" "text",
    "openai_request_id" "text",
    "is_summary" boolean DEFAULT false NOT NULL,
    "error_message" "text",
    "metadata" "jsonb"
);


ALTER TABLE "public"."llm_usage_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."llm_usage_logs" IS 'Edge Functions内のLLM呼び出しトークン使用量ログ';



COMMENT ON COLUMN "public"."llm_usage_logs"."execution_id" IS '1回の関数実行を識別するUUID';



COMMENT ON COLUMN "public"."llm_usage_logs"."is_summary" IS 'trueの場合、execution_id内の全LLM呼び出し合計';



CREATE TABLE IF NOT EXISTS "public"."meal_ai_feedbacks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meal_id" "uuid" NOT NULL,
    "feedback_text" "text" NOT NULL,
    "advice_text" "text",
    "model_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meal_ai_feedbacks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meal_image_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "planned_meal_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "dish_index" integer NOT NULL,
    "job_kind" "text" DEFAULT 'dish'::"text" NOT NULL,
    "subject_hash" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "prompt" "text" NOT NULL,
    "model" "text" NOT NULL,
    "reference_image_urls" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "lease_token" "uuid",
    "leased_until" timestamp with time zone,
    "last_error" "text",
    "result_image_url" "text",
    "request_id" "uuid",
    "trigger_source" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."meal_image_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meal_nutrition_debug_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_id" "uuid",
    "user_id" "uuid",
    "daily_meal_id" "uuid",
    "planned_meal_id" "uuid",
    "target_date" "date" NOT NULL,
    "meal_type" "text" NOT NULL,
    "dish_name" "text" NOT NULL,
    "dish_role" "text",
    "source_function" "text" DEFAULT 'generate-menu-v4'::"text" NOT NULL,
    "source_kind" "text" DEFAULT 'ingredient_match'::"text" NOT NULL,
    "input_ingredients" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "normalized_ingredients" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "ingredient_matches" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "calculated_nutrition" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "validation_result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "final_nutrition" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "issue_flags" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "dish_timing_ms" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "slot_timing_ms" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."meal_nutrition_debug_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."meal_nutrition_debug_logs" IS '献立栄養デバッグログ。材料入力、正規化、食材マッチ、参照補正、最終保存値を1皿単位で保存する';



COMMENT ON COLUMN "public"."meal_nutrition_debug_logs"."dish_timing_ms" IS '1皿単位の計測時間。食材マッチ、参照検証、料理JSON組み立てなどの詳細ms';



COMMENT ON COLUMN "public"."meal_nutrition_debug_logs"."slot_timing_ms" IS '1食単位の計測時間。daily_meal upsert、planned_meal write、debug log insert などの詳細ms';



CREATE TABLE IF NOT EXISTS "public"."meal_nutrition_estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meal_id" "uuid" NOT NULL,
    "energy_kcal" numeric,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "veg_score" integer,
    "quality_tags" "text"[],
    "raw_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meal_nutrition_estimates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "eaten_at" timestamp with time zone NOT NULL,
    "meal_type" "text" NOT NULL,
    "photo_url" "text",
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "is_sandbox" boolean DEFAULT false NOT NULL,
    "paste_group_id" "uuid"
);


ALTER TABLE "public"."meals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."meals"."is_sandbox" IS 'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';



CREATE TABLE IF NOT EXISTS "public"."membership_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" NOT NULL,
    "scope_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "actor_id" "uuid",
    "target_user_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "membership_audit_action_check" CHECK (("action" = ANY (ARRAY['group_created'::"text", 'group_dissolved'::"text", 'invite_created'::"text", 'invite_accepted'::"text", 'invite_rejected'::"text", 'invite_revoked'::"text", 'invite_expired'::"text", 'member_added'::"text", 'member_removed'::"text", 'member_left'::"text", 'child_added'::"text", 'child_promoted'::"text", 'role_changed'::"text", 'owner_transfer_proposed'::"text", 'owner_transferred'::"text", 'owner_transfer_declined'::"text", 'representative_transfer_proposed'::"text", 'representative_transferred'::"text", 'representative_transfer_declined'::"text", 'operator_force_owner_transfer'::"text", 'operator_force_representative_transfer'::"text", 'operator_force_dissolve'::"text", 'paste_executed'::"text", 'child_promotion_requested'::"text", 'child_promotion_rejected'::"text", 'child_promotion_revoked'::"text"]))),
    CONSTRAINT "membership_audit_scope_check" CHECK (("scope" = ANY (ARRAY['organization'::"text", 'family'::"text"])))
);


ALTER TABLE "public"."membership_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."metric_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text" NOT NULL,
    "unit" "text",
    "higher_is_better" boolean DEFAULT true,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."metric_definitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moderation_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meal_id" "uuid",
    "user_id" "uuid",
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "flag_type" "text" DEFAULT 'inappropriate'::"text",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "resolution_note" "text"
);


ALTER TABLE "public"."moderation_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true,
    "quiet_hours_start" time without time zone DEFAULT '22:00:00'::time without time zone,
    "quiet_hours_end" time without time zone DEFAULT '07:00:00'::time without time zone,
    "record_mode" "text" DEFAULT 'standard'::"text",
    "personality_type" "text" DEFAULT 'positive'::"text",
    "morning_reminder_enabled" boolean DEFAULT true,
    "morning_reminder_time" time without time zone DEFAULT '07:30:00'::time without time zone,
    "evening_reminder_enabled" boolean DEFAULT false,
    "evening_reminder_time" time without time zone DEFAULT '21:00:00'::time without time zone,
    "optimal_morning_time" time without time zone,
    "optimal_evening_time" time without time zone,
    "response_rate_by_hour" "jsonb",
    "last_notification_at" timestamp with time zone,
    "consecutive_ignores" integer DEFAULT 0,
    "total_notifications_sent" integer DEFAULT 0,
    "total_notifications_opened" integer DEFAULT 0,
    "vacation_mode" boolean DEFAULT false,
    "vacation_until" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "notifications_enabled" boolean DEFAULT true NOT NULL,
    "auto_analyze_enabled" boolean DEFAULT true NOT NULL,
    "data_share_enabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "notification_preferences_personality_type_check" CHECK (("personality_type" = ANY (ARRAY['positive'::"text", 'logical'::"text", 'gentle'::"text", 'competitive'::"text"]))),
    CONSTRAINT "notification_preferences_record_mode_check" CHECK (("record_mode" = ANY (ARRAY['standard'::"text", 'minimal'::"text", 'weekly'::"text", 'off'::"text"])))
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_preferences" IS '通知設定（リマインダー、性格タイプ、お休みモード）';



COMMENT ON COLUMN "public"."notification_preferences"."personality_type" IS '通知文言タイプ: positive(褒める), logical(事実), gentle(優しく), competitive(競争)';



CREATE TABLE IF NOT EXISTS "public"."nps_surveys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "score" integer NOT NULL,
    "comment" "text",
    "plan_key" character varying(100),
    "sent_at" timestamp with time zone NOT NULL,
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "nps_surveys_score_check" CHECK ((("score" >= 0) AND ("score" <= 10)))
);


ALTER TABLE "public"."nps_surveys" OWNER TO "postgres";


COMMENT ON TABLE "public"."nps_surveys" IS 'NPS アンケート。スコア 0-10。';



CREATE TABLE IF NOT EXISTS "public"."nutrition_feedback_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "target_date" "date" NOT NULL,
    "feedback" "text" NOT NULL,
    "nutrition_hash" "text" NOT NULL,
    "week_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'completed'::"text",
    CONSTRAINT "nutrition_feedback_cache_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'generating'::"text", 'completed'::"text", 'error'::"text"])))
);

ALTER TABLE ONLY "public"."nutrition_feedback_cache" REPLICA IDENTITY FULL;


ALTER TABLE "public"."nutrition_feedback_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."nutrition_targets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "daily_calories" integer,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "sodium_g" numeric,
    "sugar_g" numeric,
    "fiber_g" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "iodine_ug" numeric,
    "cholesterol_mg" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "vitamin_c_mg" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_e_mg" numeric,
    "saturated_fat_g" numeric,
    "auto_calculate" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "fiber_soluble_g" numeric,
    "fiber_insoluble_g" numeric,
    "monounsaturated_fat_g" numeric,
    "polyunsaturated_fat_g" numeric,
    "calculation_basis" "jsonb" DEFAULT '{}'::"jsonb",
    "last_calculated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."nutrition_targets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_daily_stats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "date" "date" NOT NULL,
    "member_count" integer DEFAULT 0,
    "active_member_count" integer DEFAULT 0,
    "breakfast_rate" integer DEFAULT 0,
    "late_night_rate" integer DEFAULT 0,
    "avg_score" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."org_daily_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_license_pools" (
    "organization_id" "uuid" NOT NULL,
    "total_licenses" integer,
    "used_licenses" integer DEFAULT 0 NOT NULL,
    "available_licenses" integer GENERATED ALWAYS AS ((COALESCE("total_licenses", 99999) - "used_licenses")) STORED,
    "family_addon_seats" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."org_license_pools" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_challenge_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "challenge_id" "uuid",
    "user_id" "uuid",
    "current_value" numeric DEFAULT 0,
    "rank" integer,
    "joined_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."organization_challenge_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_challenges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "challenge_type" "text" NOT NULL,
    "target_value" numeric,
    "target_unit" "text",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "reward_description" "text",
    "status" "text" DEFAULT 'active'::"text",
    "department_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "organization_challenges_challenge_type_check" CHECK (("challenge_type" = ANY (ARRAY['breakfast_rate'::"text", 'veg_score'::"text", 'cooking_rate'::"text", 'steps'::"text", 'weight_loss'::"text", 'custom'::"text"]))),
    CONSTRAINT "organization_challenges_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."organization_challenges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "report_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "data" "jsonb" NOT NULL,
    "insights" "text"[],
    "generated_by" "text" DEFAULT 'system'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "organization_reports_report_type_check" CHECK (("report_type" = ANY (ARRAY['weekly'::"text", 'monthly'::"text", 'quarterly'::"text", 'annual'::"text"])))
);


ALTER TABLE "public"."organization_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pantry_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "amount" "text",
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "expiration_date" "date",
    "added_at" "date" DEFAULT CURRENT_DATE,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pantry_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."password_history" (
    "user_id" "uuid" NOT NULL,
    "password_hash" character varying(255) NOT NULL,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."password_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."password_history" IS 'パスワード履歴。service_role のみアクセス(パスワード再利用防止)。';



CREATE TABLE IF NOT EXISTS "public"."performance_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "adjustment_type" "text" NOT NULL,
    "adjustment_value" "jsonb" NOT NULL,
    "rationale" "text" NOT NULL,
    "trigger_data" "jsonb",
    "evidence_urls" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."performance_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."performance_plans" IS 'パフォーマンス調整計画（方針スナップショット）。観測→調整ループの履歴を保持。';



CREATE TABLE IF NOT EXISTS "public"."personal_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan_key" character varying(100) NOT NULL,
    "status" character varying(20) DEFAULT 'trialing'::character varying NOT NULL,
    "trial_started_at" timestamp with time zone,
    "trial_ends_at" timestamp with time zone,
    "trial_source" character varying(50),
    "paused_at" timestamp with time zone,
    "paused_until" timestamp with time zone,
    "pause_reason" character varying(50),
    "starts_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "cancel_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "past_due_since" timestamp with time zone,
    "grace_started_at" timestamp with time zone,
    "stripe_customer_id" character varying(255),
    "stripe_subscription_id" character varying(255),
    "stripe_price_id" character varying(255),
    "active_coupon_redemption_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "personal_subscriptions_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['trialing'::character varying, 'active'::character varying, 'paused'::character varying, 'cancelled'::character varying, 'expired'::character varying, 'past_due'::character varying, 'grace'::character varying])::"text"[]))),
    CONSTRAINT "ps_paused_until_required" CHECK ((NOT ((("status")::"text" = 'paused'::"text") AND ("paused_until" IS NULL))))
);


ALTER TABLE "public"."personal_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."personal_subscriptions" IS '個人課金サブスクリプション。plan_key は subscription_plans(plan_key) FK (ON UPDATE CASCADE / ON DELETE RESTRICT)。';



CREATE TABLE IF NOT EXISTS "public"."plan_price_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "old_monthly_price_jpy" integer,
    "new_monthly_price_jpy" integer,
    "old_yearly_price_jpy" integer,
    "new_yearly_price_jpy" integer,
    "old_stripe_price_id" character varying(255),
    "new_stripe_price_id" character varying(255),
    "changed_by" "uuid" NOT NULL,
    "reason" "text",
    "effective_at" timestamp with time zone NOT NULL,
    "applies_to" character varying(30) NOT NULL,
    "affected_subscription_count" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "plan_price_history_applies_to_check" CHECK ((("applies_to")::"text" = ANY ((ARRAY['new_only'::character varying, 'on_renewal'::character varying, 'immediately'::character varying])::"text"[])))
);


ALTER TABLE "public"."plan_price_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."plan_price_history" IS 'プラン価格変更履歴。不可逆(UPDATE/DELETE 禁止)。';



CREATE TABLE IF NOT EXISTS "public"."planned_meals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meal_type" "text" NOT NULL,
    "dish_name" "text" NOT NULL,
    "recipe_url" "text",
    "image_url" "text",
    "description" "text",
    "ingredients" "text"[],
    "calories_kcal" integer,
    "protein_g" numeric,
    "fat_g" numeric,
    "carbs_g" numeric,
    "is_completed" boolean DEFAULT false,
    "completed_at" timestamp with time zone,
    "actual_meal_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "mode" "text" DEFAULT 'cook'::"text",
    "dishes" "jsonb",
    "is_simple" boolean DEFAULT true,
    "cooking_time_minutes" integer,
    "memo" "text",
    "veg_score" integer,
    "quality_tags" "text"[],
    "display_order" integer DEFAULT 0,
    "sodium_g" numeric,
    "sugar_g" numeric,
    "fiber_g" numeric,
    "fiber_soluble_g" numeric,
    "fiber_insoluble_g" numeric,
    "potassium_mg" numeric,
    "calcium_mg" numeric,
    "phosphorus_mg" numeric,
    "iron_mg" numeric,
    "zinc_mg" numeric,
    "iodine_ug" numeric,
    "cholesterol_mg" numeric,
    "vitamin_b1_mg" numeric,
    "vitamin_b2_mg" numeric,
    "vitamin_b6_mg" numeric,
    "vitamin_b12_ug" numeric,
    "folic_acid_ug" numeric,
    "vitamin_c_mg" numeric,
    "vitamin_a_ug" numeric,
    "vitamin_d_ug" numeric,
    "vitamin_k_ug" numeric,
    "vitamin_e_mg" numeric,
    "saturated_fat_g" numeric,
    "monounsaturated_fat_g" numeric,
    "polyunsaturated_fat_g" numeric,
    "amino_acid_g" numeric,
    "recipe_steps" "text"[],
    "is_generating" boolean DEFAULT false,
    "source_type" "text" DEFAULT 'legacy'::"text" NOT NULL,
    "source_dataset_version" "text",
    "source_menu_set_external_id" "text",
    "generation_metadata" "jsonb",
    "magnesium_mg" numeric,
    "daily_meal_id" "uuid",
    "catalog_product_id" "uuid"
);


ALTER TABLE "public"."planned_meals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."planned_meals"."mode" IS 'Meal mode: cook, quick, buy, out, skip';



COMMENT ON COLUMN "public"."planned_meals"."dishes" IS 'JSON structure: {"main": {"name": "...", "cal": 0, "ingredient": "..."}, "side1": {...}, "side2": {...}, "soup": {...}}';



COMMENT ON COLUMN "public"."planned_meals"."memo" IS 'ユーザーのメモ・コメント';



COMMENT ON COLUMN "public"."planned_meals"."veg_score" IS '野菜スコア（1-5）';



COMMENT ON COLUMN "public"."planned_meals"."quality_tags" IS '品質タグ（例: 高タンパク, 低カロリー, etc）';



COMMENT ON COLUMN "public"."planned_meals"."sodium_g" IS 'ナトリウム（塩分）g';



COMMENT ON COLUMN "public"."planned_meals"."sugar_g" IS '糖質 g';



COMMENT ON COLUMN "public"."planned_meals"."fiber_g" IS '食物繊維 g';



COMMENT ON COLUMN "public"."planned_meals"."fiber_soluble_g" IS '水溶性食物繊維 g';



COMMENT ON COLUMN "public"."planned_meals"."fiber_insoluble_g" IS '不溶性食物繊維 g';



COMMENT ON COLUMN "public"."planned_meals"."potassium_mg" IS 'カリウム mg';



COMMENT ON COLUMN "public"."planned_meals"."calcium_mg" IS 'カルシウム mg';



COMMENT ON COLUMN "public"."planned_meals"."phosphorus_mg" IS 'リン mg';



COMMENT ON COLUMN "public"."planned_meals"."iron_mg" IS '鉄分 mg';



COMMENT ON COLUMN "public"."planned_meals"."zinc_mg" IS '亜鉛 mg';



COMMENT ON COLUMN "public"."planned_meals"."iodine_ug" IS 'ヨウ素 µg';



COMMENT ON COLUMN "public"."planned_meals"."cholesterol_mg" IS 'コレステロール mg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_b1_mg" IS 'ビタミンB1 mg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_b2_mg" IS 'ビタミンB2 mg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_b6_mg" IS 'ビタミンB6 mg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_b12_ug" IS 'ビタミンB12 µg';



COMMENT ON COLUMN "public"."planned_meals"."folic_acid_ug" IS '葉酸 µg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_c_mg" IS 'ビタミンC mg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_a_ug" IS 'ビタミンA µg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_d_ug" IS 'ビタミンD µg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_k_ug" IS 'ビタミンK µg';



COMMENT ON COLUMN "public"."planned_meals"."vitamin_e_mg" IS 'ビタミンE mg';



COMMENT ON COLUMN "public"."planned_meals"."saturated_fat_g" IS '飽和脂肪酸 g';



COMMENT ON COLUMN "public"."planned_meals"."monounsaturated_fat_g" IS '一価不飽和脂肪酸 g';



COMMENT ON COLUMN "public"."planned_meals"."polyunsaturated_fat_g" IS '多価不飽和脂肪酸 g';



COMMENT ON COLUMN "public"."planned_meals"."amino_acid_g" IS 'アミノ酸 g';



COMMENT ON COLUMN "public"."planned_meals"."recipe_steps" IS 'レシピの作り方手順（配列）。例: ["1. 鶏肉を一口大に切る", "2. フライパンで焼く"]';



CREATE TABLE IF NOT EXISTS "public"."recipe_collection_items" (
    "collection_id" "uuid" NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recipe_collection_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipe_collections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "is_public" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "recipe_ids" "uuid"[] DEFAULT '{}'::"uuid"[]
);


ALTER TABLE "public"."recipe_collections" OWNER TO "postgres";


COMMENT ON COLUMN "public"."recipe_collections"."recipe_ids" IS 'コレクションに含まれるレシピIDの配列';



CREATE TABLE IF NOT EXISTS "public"."recipe_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid",
    "user_id" "uuid",
    "content" "text" NOT NULL,
    "rating" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "recipe_comments_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."recipe_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipe_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid",
    "reporter_id" "uuid",
    "flag_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recipe_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipe_likes" (
    "user_id" "uuid" NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "recipe_uuid" "uuid",
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."recipe_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipe_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "base_meal_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "prompt" "text",
    "result_text" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recipe_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "calories_kcal" integer,
    "cooking_time_minutes" integer,
    "servings" integer DEFAULT 1,
    "image_url" "text",
    "ingredients" "jsonb",
    "steps" "text"[],
    "is_public" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "category" "text" DEFAULT 'main'::"text",
    "cuisine_type" "text" DEFAULT 'japanese'::"text",
    "difficulty" "text" DEFAULT 'easy'::"text",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "nutrition" "jsonb",
    "tips" "text",
    "video_url" "text",
    "source_url" "text",
    "view_count" integer DEFAULT 0,
    "like_count" integer DEFAULT 0
);


ALTER TABLE "public"."recipes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."referral_rewards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "referrer_id" "uuid" NOT NULL,
    "referred_id" "uuid" NOT NULL,
    "reward_type" character varying(30) NOT NULL,
    "reward_value" "jsonb" NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "granted_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "referral_rewards_reward_type_check" CHECK ((("reward_type")::"text" = ANY ((ARRAY['credit'::character varying, 'coupon'::character varying, 'extension'::character varying])::"text"[]))),
    CONSTRAINT "referral_rewards_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'granted'::character varying, 'expired'::character varying])::"text"[])))
);


ALTER TABLE "public"."referral_rewards" OWNER TO "postgres";


COMMENT ON TABLE "public"."referral_rewards" IS '紹介報酬。紹介者・被紹介者双方が自分のレコードを参照可能。';



CREATE TABLE IF NOT EXISTS "public"."revenue_snapshots" (
    "date" "date" NOT NULL,
    "personal_active_users" integer DEFAULT 0 NOT NULL,
    "personal_mrr_jpy" integer DEFAULT 0 NOT NULL,
    "family_active_groups" integer DEFAULT 0 NOT NULL,
    "family_mrr_jpy" integer DEFAULT 0 NOT NULL,
    "org_active_orgs" integer DEFAULT 0 NOT NULL,
    "org_active_seats" integer DEFAULT 0 NOT NULL,
    "org_mrr_jpy" integer DEFAULT 0 NOT NULL,
    "total_mrr_jpy" integer DEFAULT 0 NOT NULL,
    "total_arr_jpy" integer DEFAULT 0 NOT NULL,
    "new_signups" integer DEFAULT 0 NOT NULL,
    "cancellations" integer DEFAULT 0 NOT NULL,
    "upgrade_count" integer DEFAULT 0 NOT NULL,
    "downgrade_count" integer DEFAULT 0 NOT NULL,
    "trial_starts" integer DEFAULT 0 NOT NULL,
    "trial_conversions" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."revenue_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."revenue_snapshots" IS '収益日次スナップショット。日次バッチで集計される。';



CREATE TABLE IF NOT EXISTS "public"."sales_lead_activities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "activity_type" character varying(30) NOT NULL,
    "details" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_lead_activities_activity_type_check" CHECK ((("activity_type")::"text" = ANY ((ARRAY['call'::character varying, 'email'::character varying, 'meeting'::character varying, 'note'::character varying, 'stage_change'::character varying])::"text"[])))
);


ALTER TABLE "public"."sales_lead_activities" OWNER TO "postgres";


COMMENT ON TABLE "public"."sales_lead_activities" IS '営業活動ログ。設計書別名: sales_activities。';



CREATE TABLE IF NOT EXISTS "public"."sales_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_name" character varying(200) NOT NULL,
    "industry" character varying(100),
    "employee_count" integer,
    "contact_name" character varying(100),
    "contact_email" character varying(255),
    "contact_phone" character varying(50),
    "source" character varying(50),
    "stage" character varying(30) DEFAULT 'approach'::character varying NOT NULL,
    "assigned_to" "uuid",
    "estimated_acv" integer,
    "notes" "text",
    "converted_org_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sales_leads_source_check" CHECK ((("source")::"text" = ANY ((ARRAY['website'::character varying, 'referral'::character varying, 'event'::character varying, 'cold_call'::character varying, 'other'::character varying])::"text"[]))),
    CONSTRAINT "sales_leads_stage_check" CHECK ((("stage")::"text" = ANY ((ARRAY['approach'::character varying, 'meeting'::character varying, 'proposal'::character varying, 'negotiation'::character varying, 'won'::character varying, 'lost'::character varying])::"text"[])))
);


ALTER TABLE "public"."sales_leads" OWNER TO "postgres";


COMMENT ON TABLE "public"."sales_leads" IS '法人見込み客(リード)管理。';



CREATE TABLE IF NOT EXISTS "public"."segment_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "axes" "jsonb" NOT NULL,
    "level" integer DEFAULT 1 NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."segment_definitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."segment_stats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "segment_id" "uuid",
    "metric_id" "uuid",
    "period_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "user_count" integer DEFAULT 0 NOT NULL,
    "avg_value" numeric,
    "median_value" numeric,
    "min_value" numeric,
    "max_value" numeric,
    "p10_value" numeric,
    "p25_value" numeric,
    "p75_value" numeric,
    "p90_value" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."segment_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shopping_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text" DEFAULT 'その他'::"text" NOT NULL,
    "item_name" "text" NOT NULL,
    "quantity" "text",
    "is_checked" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "normalized_name" "text",
    "quantity_variants" "jsonb" DEFAULT '[]'::"jsonb",
    "selected_variant_index" integer DEFAULT 0,
    "shopping_list_id" "uuid"
);


ALTER TABLE "public"."shopping_list_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."shopping_list_items"."source" IS 'manual=手動追加, generated=献立から自動生成';



COMMENT ON COLUMN "public"."shopping_list_items"."normalized_name" IS 'LLMが正規化した材料名。表記ゆれ吸収・重複マージに使用';



COMMENT ON COLUMN "public"."shopping_list_items"."quantity_variants" IS '数量バリエーション配列。同じ必要量の別表現（例: g と 枚）。UIでタップ切り替え可能';



COMMENT ON COLUMN "public"."shopping_list_items"."selected_variant_index" IS '現在選択中のquantity_variantsのインデックス。0始まり';



CREATE TABLE IF NOT EXISTS "public"."shopping_list_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "meal_plan_id" "uuid",
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "progress" "jsonb" DEFAULT '{"phase": "pending", "message": "準備中...", "percentage": 0}'::"jsonb",
    "result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "start_date" "date",
    "end_date" "date",
    "shopping_list_id" "uuid",
    CONSTRAINT "shopping_list_requests_status_check" CHECK (("status" = ANY (ARRAY['processing'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."shopping_list_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."shopping_list_requests" IS '買い物リスト生成の非同期リクエスト管理';



COMMENT ON COLUMN "public"."shopping_list_requests"."meal_plan_id" IS '非推奨: 日付ベースモデル移行後は使用しない';



COMMENT ON COLUMN "public"."shopping_list_requests"."progress" IS '進捗状況 {phase, message, percentage}';



COMMENT ON COLUMN "public"."shopping_list_requests"."start_date" IS '買い物リスト生成の開始日';



COMMENT ON COLUMN "public"."shopping_list_requests"."end_date" IS '買い物リスト生成の終了日';



CREATE TABLE IF NOT EXISTS "public"."shopping_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "servings_config" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."shopping_lists" OWNER TO "postgres";


COMMENT ON TABLE "public"."shopping_lists" IS '買い物リストの親テーブル。任意の日付範囲で生成可能。';



COMMENT ON COLUMN "public"."shopping_lists"."status" IS 'active=現在使用中, archived=過去のリスト';



COMMENT ON COLUMN "public"."shopping_lists"."servings_config" IS '生成時に使用した人数設定';



CREATE TABLE IF NOT EXISTS "public"."sport_presets" (
    "id" "text" NOT NULL,
    "name_ja" "text" NOT NULL,
    "name_en" "text" NOT NULL,
    "category" "text" NOT NULL,
    "roles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "demand_vector" "jsonb" NOT NULL,
    "phase_descriptions" "jsonb",
    "is_weight_class" boolean DEFAULT false,
    "is_team_sport" boolean DEFAULT false,
    "typical_competition_duration" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sport_presets" OWNER TO "postgres";


COMMENT ON TABLE "public"."sport_presets" IS 'スポーツプリセット100種目。roles/experience/phases/demand_vectorを定義。';



CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "id" character varying(255) NOT NULL,
    "event_type" character varying(100) NOT NULL,
    "payload" "jsonb" NOT NULL,
    "processing_status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "processed_at" timestamp with time zone,
    "error_message" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stripe_webhook_events_processing_status_check" CHECK ((("processing_status")::"text" = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying])::"text"[])))
);


ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."stripe_webhook_events" IS 'Stripe Webhook 冪等化テーブル。PK = Stripe event.id。service_role のみアクセス。';



CREATE TABLE IF NOT EXISTS "public"."subscription_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_key" character varying(100) NOT NULL,
    "display_name" character varying(200) NOT NULL,
    "plan_type" character varying(20) NOT NULL,
    "description" "text",
    "monthly_price_jpy" integer,
    "yearly_price_jpy" integer,
    "currency" character varying(3) DEFAULT 'JPY'::character varying NOT NULL,
    "stripe_product_id" character varying(255),
    "stripe_price_id" character varying(255),
    "max_members" integer,
    "max_family_seats" integer,
    "feature_packages" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "status" character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "banner_url" "text",
    "trial_days" integer DEFAULT 0 NOT NULL,
    "min_contract_months" integer DEFAULT 1 NOT NULL,
    "auto_renew_default" boolean DEFAULT true NOT NULL,
    "ends_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "superseded_by_plan_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_plans_plan_type_check" CHECK ((("plan_type")::"text" = ANY ((ARRAY['personal'::character varying, 'family'::character varying, 'org'::character varying])::"text"[]))),
    CONSTRAINT "subscription_plans_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['draft'::character varying, 'public'::character varying, 'private'::character varying, 'deprecated'::character varying])::"text"[])))
);


ALTER TABLE "public"."subscription_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscription_plans" IS 'プラン定義マスター。全ドメインの plan_key FK 起点。';



CREATE TABLE IF NOT EXISTS "public"."support_ticket_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "is_internal" boolean DEFAULT false NOT NULL,
    "body" "text" NOT NULL,
    "attachments" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_ticket_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."support_ticket_messages" IS 'サポートチケットメッセージ。閲覧: チケット所有者は自分のチケットの is_internal=false のみ、support/admin/super_admin は全件。作成: sender_id=auth.uid() 必須、所有者は自チケットへ is_internal=false のみ、staff は任意チケットへ is_internal 指定可。UPDATE/DELETE はポリシー無し (暗黙DENY)。Issue #1233 で所有権検証を追加。';



CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subject" character varying(200) NOT NULL,
    "category" character varying(50) NOT NULL,
    "priority" character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'open'::character varying NOT NULL,
    "assignee_id" "uuid",
    "first_response_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "organization_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "support_tickets_category_check" CHECK ((("category")::"text" = ANY ((ARRAY['account'::character varying, 'billing'::character varying, 'feature'::character varying, 'bug'::character varying, 'other'::character varying])::"text"[]))),
    CONSTRAINT "support_tickets_priority_check" CHECK ((("priority")::"text" = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::"text"[]))),
    CONSTRAINT "support_tickets_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'pending'::character varying, 'resolved'::character varying, 'closed'::character varying])::"text"[])))
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


COMMENT ON TABLE "public"."support_tickets" IS 'サポートチケット。SLA トラッキング対応。';



CREATE TABLE IF NOT EXISTS "public"."system_daily_stats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "date" "date" NOT NULL,
    "total_users" integer DEFAULT 0,
    "new_users" integer DEFAULT 0,
    "active_users" integer DEFAULT 0,
    "dau" integer DEFAULT 0,
    "total_planned_meals" integer DEFAULT 0,
    "completed_meals" integer DEFAULT 0,
    "ai_generated_meals" integer DEFAULT 0,
    "health_records_count" integer DEFAULT 0,
    "ai_requests_count" integer DEFAULT 0,
    "ai_tokens_used" integer DEFAULT 0,
    "ai_cost_usd" numeric(10,4) DEFAULT 0,
    "error_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."system_daily_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."system_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."terms_acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "document_type" character varying(50) NOT NULL,
    "document_version" character varying(20) NOT NULL,
    "accepted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    CONSTRAINT "terms_acceptances_document_type_check" CHECK ((("document_type")::"text" = ANY ((ARRAY['terms_of_service'::character varying, 'privacy_policy'::character varying, 'parental_consent'::character varying, 'external_data_provision'::character varying])::"text"[])))
);


ALTER TABLE "public"."terms_acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_acceptances" IS '利用規約・プライバシーポリシー同意記録。不可逆(UPDATE/DELETE禁止)。';



CREATE TABLE IF NOT EXISTS "public"."user_badges" (
    "user_id" "uuid" NOT NULL,
    "badge_id" "uuid" NOT NULL,
    "obtained_at" timestamp with time zone DEFAULT "now"(),
    "context_json" "jsonb",
    "message" "text"
);


ALTER TABLE "public"."user_badges" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."user_consultation_history" AS
 SELECT "s"."id" AS "session_id",
    "s"."user_id",
    "s"."title",
    "s"."summary",
    "s"."key_topics",
    "s"."action_history",
    "s"."created_at" AS "session_started",
    "s"."updated_at" AS "session_updated",
    "s"."summary_generated_at",
    "count"("m"."id") AS "message_count",
    "sum"(
        CASE
            WHEN "m"."is_important" THEN 1
            ELSE 0
        END) AS "important_message_count"
   FROM ("public"."ai_consultation_sessions" "s"
     LEFT JOIN "public"."ai_consultation_messages" "m" ON (("s"."id" = "m"."session_id")))
  GROUP BY "s"."id", "s"."user_id", "s"."title", "s"."summary", "s"."key_topics", "s"."action_history", "s"."created_at", "s"."updated_at", "s"."summary_generated_at";


ALTER VIEW "public"."user_consultation_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_daily_meals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "day_date" "date" NOT NULL,
    "theme" "text",
    "nutritional_focus" "text",
    "is_cheat_day" boolean DEFAULT false,
    "source_request_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "is_sandbox" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."user_daily_meals" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_daily_meals" IS '日付ベースの献立管理テーブル。meal_plan_days の置き換え。';



COMMENT ON COLUMN "public"."user_daily_meals"."day_date" IS '献立の日付（YYYY-MM-DD）';



COMMENT ON COLUMN "public"."user_daily_meals"."theme" IS 'その日のテーマ（和食の日、時短メニュー等）';



COMMENT ON COLUMN "public"."user_daily_meals"."is_cheat_day" IS 'チートデーかどうか';



COMMENT ON COLUMN "public"."user_daily_meals"."is_sandbox" IS 'true = ハンズオンチュートリアル中の sandbox 投入 (family/09)';



CREATE TABLE IF NOT EXISTS "public"."user_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "metric_id" "uuid",
    "period_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "value" numeric NOT NULL,
    "previous_value" numeric,
    "change_rate" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_performance_checkins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "checkin_date" "date" NOT NULL,
    "sleep_hours" numeric(3,1),
    "sleep_quality" smallint,
    "fatigue" smallint,
    "focus" smallint,
    "hunger" smallint,
    "training_load_rpe" smallint,
    "training_minutes" integer,
    "weight" numeric(5,2),
    "body_fat_percentage" numeric(4,1),
    "resting_heart_rate" integer,
    "mood" smallint,
    "soreness" smallint,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_performance_checkins_fatigue_check" CHECK ((("fatigue" >= 1) AND ("fatigue" <= 5))),
    CONSTRAINT "user_performance_checkins_focus_check" CHECK ((("focus" >= 1) AND ("focus" <= 5))),
    CONSTRAINT "user_performance_checkins_hunger_check" CHECK ((("hunger" >= 1) AND ("hunger" <= 5))),
    CONSTRAINT "user_performance_checkins_mood_check" CHECK ((("mood" >= 1) AND ("mood" <= 5))),
    CONSTRAINT "user_performance_checkins_sleep_quality_check" CHECK ((("sleep_quality" >= 1) AND ("sleep_quality" <= 5))),
    CONSTRAINT "user_performance_checkins_soreness_check" CHECK ((("soreness" >= 1) AND ("soreness" <= 5))),
    CONSTRAINT "user_performance_checkins_training_load_rpe_check" CHECK ((("training_load_rpe" >= 1) AND ("training_load_rpe" <= 10)))
);


ALTER TABLE "public"."user_performance_checkins" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_performance_checkins" IS '日次パフォーマンスチェックイン（観測データ）。7日分揃うと個別最適化が有効になる。';



CREATE TABLE IF NOT EXISTS "public"."user_push_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "expo_push_token" "text" NOT NULL,
    "platform" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "device_name" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_segment_rankings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "segment_id" "uuid",
    "metric_id" "uuid",
    "period_type" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "rank" integer NOT NULL,
    "total_users" integer NOT NULL,
    "percentile" numeric NOT NULL,
    "value" numeric NOT NULL,
    "vs_avg_rate" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_segment_rankings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_sessions_metadata" (
    "session_id" character varying(255) NOT NULL,
    "user_id" "uuid" NOT NULL,
    "device_name" character varying(200),
    "ip_address" "inet",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_active_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."user_sessions_metadata" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_sessions_metadata" IS 'ユーザーセッションメタデータ。デバイス管理・セッション失効に使用。';



CREATE TABLE IF NOT EXISTS "public"."weekly_menus" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "content" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."weekly_menus" OWNER TO "postgres";


ALTER TABLE ONLY "public"."iroca_calibration_shots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_calibration_shots_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."iroca_correction_model" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_correction_model_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."iroca_measurements" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_measurements_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."iroca_sample_summary" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_sample_summary_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_consultation_messages"
    ADD CONSTRAINT "ai_consultation_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_consultation_sessions"
    ADD CONSTRAINT "ai_consultation_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_content_logs"
    ADD CONSTRAINT "ai_content_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("user_id", "announcement_id");



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_logs"
    ADD CONSTRAINT "app_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."badges"
    ADD CONSTRAINT "badges_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."badges"
    ADD CONSTRAINT "badges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blood_test_longitudinal_reviews"
    ADD CONSTRAINT "blood_test_longitudinal_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blood_test_results"
    ADD CONSTRAINT "blood_test_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_1_user_id_2_key" UNIQUE ("user_id_1", "user_id_2");



ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_import_runs"
    ADD CONSTRAINT "catalog_import_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_product_snapshots"
    ADD CONSTRAINT "catalog_product_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_product_snapshots"
    ADD CONSTRAINT "catalog_product_snapshots_product_id_snapshot_hash_key" UNIQUE ("product_id", "snapshot_hash");



ALTER TABLE ONLY "public"."catalog_products"
    ADD CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_products"
    ADD CONSTRAINT "catalog_products_source_id_external_id_key" UNIQUE ("source_id", "external_id");



ALTER TABLE ONLY "public"."catalog_raw_documents"
    ADD CONSTRAINT "catalog_raw_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_source_categories"
    ADD CONSTRAINT "catalog_source_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."catalog_source_categories"
    ADD CONSTRAINT "catalog_source_categories_source_id_category_code_key" UNIQUE ("source_id", "category_code");



ALTER TABLE ONLY "public"."catalog_sources"
    ADD CONSTRAINT "catalog_sources_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."catalog_sources"
    ADD CONSTRAINT "catalog_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cookie_consents"
    ADD CONSTRAINT "cookie_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."csat_feedbacks"
    ADD CONSTRAINT "csat_feedbacks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_active_users"
    ADD CONSTRAINT "daily_active_users_pkey" PRIMARY KEY ("date", "plan_type", "plan_key");



ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_user_id_date_key" UNIQUE ("user_id", "date");



ALTER TABLE ONLY "public"."dataset_import_runs"
    ADD CONSTRAINT "dataset_import_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dataset_ingredients"
    ADD CONSTRAINT "dataset_ingredients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dataset_menu_sets"
    ADD CONSTRAINT "dataset_menu_sets_external_id_key" UNIQUE ("external_id");



ALTER TABLE ONLY "public"."dataset_menu_sets"
    ADD CONSTRAINT "dataset_menu_sets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dataset_recipes"
    ADD CONSTRAINT "dataset_recipes_external_id_key" UNIQUE ("external_id");



ALTER TABLE ONLY "public"."dataset_recipes"
    ADD CONSTRAINT "dataset_recipes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."derived_recipes"
    ADD CONSTRAINT "derived_recipes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_blacklist"
    ADD CONSTRAINT "email_blacklist_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."email_delivery_logs"
    ADD CONSTRAINT "email_delivery_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."embedding_jobs"
    ADD CONSTRAINT "embedding_jobs_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."embedding_jobs"
    ADD CONSTRAINT "embedding_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("experiment_id", "user_id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_data_consents"
    ADD CONSTRAINT "external_data_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."failed_invite_lookups"
    ADD CONSTRAINT "failed_invite_lookups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legacy_family_groups"
    ADD CONSTRAINT "family_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_groups"
    ADD CONSTRAINT "family_groups_pkey1" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_pkey1" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."feature_packages"
    ADD CONSTRAINT "feature_packages_package_key_key" UNIQUE ("package_key");



ALTER TABLE ONLY "public"."feature_packages"
    ADD CONSTRAINT "feature_packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gdpr_deletion_requests"
    ADD CONSTRAINT "gdpr_deletion_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_challenges"
    ADD CONSTRAINT "health_challenges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_checkup_longitudinal_reviews"
    ADD CONSTRAINT "health_checkup_longitudinal_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_checkups"
    ADD CONSTRAINT "health_checkups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_checkups"
    ADD CONSTRAINT "health_checkups_user_date_unique" UNIQUE ("user_id", "checkup_date");



ALTER TABLE ONLY "public"."health_goals"
    ADD CONSTRAINT "health_goals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_insights"
    ADD CONSTRAINT "health_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_records"
    ADD CONSTRAINT "health_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_records"
    ADD CONSTRAINT "health_records_user_id_record_date_key" UNIQUE ("user_id", "record_date");



ALTER TABLE ONLY "public"."health_streaks"
    ADD CONSTRAINT "health_streaks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_streaks"
    ADD CONSTRAINT "health_streaks_user_id_streak_type_key" UNIQUE ("user_id", "streak_type");



ALTER TABLE ONLY "public"."help_articles"
    ADD CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."help_articles"
    ADD CONSTRAINT "help_articles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."infra_alerts"
    ADD CONSTRAINT "infra_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."infra_metrics"
    ADD CONSTRAINT "infra_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ingredient_match_cache"
    ADD CONSTRAINT "ingredient_match_cache_input_name_key" UNIQUE ("input_name");



ALTER TABLE ONLY "public"."ingredient_match_cache"
    ADD CONSTRAINT "ingredient_match_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inquiries"
    ADD CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_calibration_shots"
    ADD CONSTRAINT "iroca_calibration_shots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_correction_model"
    ADD CONSTRAINT "iroca_correction_model_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_experiment_plan"
    ADD CONSTRAINT "iroca_experiment_plan_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_measurements"
    ADD CONSTRAINT "iroca_measurements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_measurements"
    ADD CONSTRAINT "iroca_measurements_sample_name_meas_index_key" UNIQUE ("sample_name", "meas_index");



ALTER TABLE ONLY "public"."iroca_sample_summary"
    ADD CONSTRAINT "iroca_sample_summary_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."iroca_sample_summary"
    ADD CONSTRAINT "iroca_sample_summary_sample_name_key" UNIQUE ("sample_name");



ALTER TABLE ONLY "public"."llm_usage_logs"
    ADD CONSTRAINT "llm_usage_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meal_ai_feedbacks"
    ADD CONSTRAINT "meal_ai_feedbacks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meal_image_jobs"
    ADD CONSTRAINT "meal_image_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meal_nutrition_debug_logs"
    ADD CONSTRAINT "meal_nutrition_debug_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meal_nutrition_estimates"
    ADD CONSTRAINT "meal_nutrition_estimates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meals"
    ADD CONSTRAINT "meals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership_audit"
    ADD CONSTRAINT "membership_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."metric_definitions"
    ADD CONSTRAINT "metric_definitions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."metric_definitions"
    ADD CONSTRAINT "metric_definitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."nps_surveys"
    ADD CONSTRAINT "nps_surveys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_user_id_target_date_key" UNIQUE ("user_id", "target_date");



ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_organization_id_date_key" UNIQUE ("organization_id", "date");



ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_license_pools"
    ADD CONSTRAINT "org_license_pools_pkey" PRIMARY KEY ("organization_id");



ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_challenge_id_user_id_key" UNIQUE ("challenge_id", "user_id");



ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."organization_reports"
    ADD CONSTRAINT "organization_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ownership_transfer_proposals"
    ADD CONSTRAINT "ownership_transfer_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_history"
    ADD CONSTRAINT "password_history_pkey" PRIMARY KEY ("user_id", "changed_at");



ALTER TABLE ONLY "public"."performance_plans"
    ADD CONSTRAINT "performance_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_subscriptions"
    ADD CONSTRAINT "personal_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_subscriptions"
    ADD CONSTRAINT "personal_subscriptions_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."plan_price_history"
    ADD CONSTRAINT "plan_price_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planned_meals"
    ADD CONSTRAINT "planned_meals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_pkey" PRIMARY KEY ("collection_id", "recipe_id");



ALTER TABLE ONLY "public"."recipe_collections"
    ADD CONSTRAINT "recipe_collections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_likes"
    ADD CONSTRAINT "recipe_likes_pkey" PRIMARY KEY ("user_id", "recipe_id");



ALTER TABLE ONLY "public"."recipe_requests"
    ADD CONSTRAINT "recipe_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_rewards"
    ADD CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."revenue_snapshots"
    ADD CONSTRAINT "revenue_snapshots_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."sales_lead_activities"
    ADD CONSTRAINT "sales_lead_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_leads"
    ADD CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."segment_definitions"
    ADD CONSTRAINT "segment_definitions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."segment_definitions"
    ADD CONSTRAINT "segment_definitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_segment_id_metric_id_period_type_period_start_key" UNIQUE ("segment_id", "metric_id", "period_type", "period_start");



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shopping_list_requests"
    ADD CONSTRAINT "shopping_list_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sport_presets"
    ADD CONSTRAINT "sport_presets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_plan_key_key" UNIQUE ("plan_key");



ALTER TABLE ONLY "public"."support_ticket_messages"
    ADD CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_daily_stats"
    ADD CONSTRAINT "system_daily_stats_date_key" UNIQUE ("date");



ALTER TABLE ONLY "public"."system_daily_stats"
    ADD CONSTRAINT "system_daily_stats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_pkey" PRIMARY KEY ("user_id", "badge_id");



ALTER TABLE ONLY "public"."user_daily_meals"
    ADD CONSTRAINT "user_daily_meals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_daily_meals"
    ADD CONSTRAINT "user_daily_meals_user_id_day_date_key" UNIQUE ("user_id", "day_date");



ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_user_id_metric_id_period_type_period_start_key" UNIQUE ("user_id", "metric_id", "period_type", "period_start");



ALTER TABLE ONLY "public"."user_performance_checkins"
    ADD CONSTRAINT "user_performance_checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_performance_checkins"
    ADD CONSTRAINT "user_performance_checkins_user_id_checkin_date_key" UNIQUE ("user_id", "checkin_date");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_push_tokens"
    ADD CONSTRAINT "user_push_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_user_id_segment_id_metric_id_period_t_key" UNIQUE ("user_id", "segment_id", "metric_id", "period_type", "period_start");



ALTER TABLE ONLY "public"."user_sessions_metadata"
    ADD CONSTRAINT "user_sessions_metadata_pkey" PRIMARY KEY ("session_id");



ALTER TABLE ONLY "public"."weekly_menu_requests"
    ADD CONSTRAINT "weekly_menu_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_admin_user_notes_user_id" ON "public"."admin_user_notes" USING "btree" ("user_id");



CREATE INDEX "idx_ai_action_logs_session_id" ON "public"."ai_action_logs" USING "btree" ("session_id");



CREATE INDEX "idx_ai_action_logs_status" ON "public"."ai_action_logs" USING "btree" ("status");



CREATE INDEX "idx_ai_consultation_messages_important" ON "public"."ai_consultation_messages" USING "btree" ("session_id", "is_important") WHERE ("is_important" = true);



CREATE INDEX "idx_ai_consultation_messages_session_id" ON "public"."ai_consultation_messages" USING "btree" ("session_id");



CREATE INDEX "idx_ai_consultation_sessions_status" ON "public"."ai_consultation_sessions" USING "btree" ("status");



CREATE INDEX "idx_ai_consultation_sessions_user_id" ON "public"."ai_consultation_sessions" USING "btree" ("user_id");



CREATE INDEX "idx_ai_content_logs_created_at" ON "public"."ai_content_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_ai_content_logs_user_id" ON "public"."ai_content_logs" USING "btree" ("user_id");



CREATE INDEX "idx_announcement_reads_user_id" ON "public"."announcement_reads" USING "btree" ("user_id");



CREATE INDEX "idx_app_logs_created_at" ON "public"."app_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_app_logs_function_name" ON "public"."app_logs" USING "btree" ("function_name");



CREATE INDEX "idx_app_logs_level" ON "public"."app_logs" USING "btree" ("level");



CREATE INDEX "idx_app_logs_source" ON "public"."app_logs" USING "btree" ("source");



CREATE INDEX "idx_app_logs_user_id" ON "public"."app_logs" USING "btree" ("user_id");



CREATE INDEX "idx_audit_logs_action" ON "public"."admin_audit_logs" USING "btree" ("action_type", "created_at" DESC);



CREATE INDEX "idx_audit_logs_actor" ON "public"."admin_audit_logs" USING "btree" ("actor_id", "created_at" DESC);



CREATE INDEX "idx_audit_logs_severity" ON "public"."admin_audit_logs" USING "btree" ("severity", "created_at" DESC);



CREATE INDEX "idx_audit_logs_target" ON "public"."admin_audit_logs" USING "btree" ("target_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_blood_test_longitudinal_review_user" ON "public"."blood_test_longitudinal_reviews" USING "btree" ("user_id");



CREATE INDEX "idx_blood_test_user_date" ON "public"."blood_test_results" USING "btree" ("user_id", "test_date" DESC);



CREATE INDEX "idx_calib_shots_sample" ON "public"."iroca_calibration_shots" USING "btree" ("sample_name");



CREATE INDEX "idx_catalog_import_runs_source_started_at" ON "public"."catalog_import_runs" USING "btree" ("source_id", "started_at" DESC);



CREATE INDEX "idx_catalog_import_runs_status" ON "public"."catalog_import_runs" USING "btree" ("status", "started_at" DESC);



CREATE INDEX "idx_catalog_product_snapshots_product_captured_at" ON "public"."catalog_product_snapshots" USING "btree" ("product_id", "captured_at" DESC);



CREATE INDEX "idx_catalog_products_last_seen_at" ON "public"."catalog_products" USING "btree" ("last_seen_at" DESC);



CREATE INDEX "idx_catalog_products_name_norm" ON "public"."catalog_products" USING "btree" ("name_norm");



CREATE INDEX "idx_catalog_products_name_norm_trgm" ON "public"."catalog_products" USING "gin" ("name_norm" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_catalog_products_source_category_status" ON "public"."catalog_products" USING "btree" ("source_id", "category_code", "availability_status");



CREATE INDEX "idx_catalog_raw_documents_import_run" ON "public"."catalog_raw_documents" USING "btree" ("import_run_id", "fetched_at" DESC);



CREATE INDEX "idx_catalog_source_categories_source_active" ON "public"."catalog_source_categories" USING "btree" ("source_id", "is_active", "crawl_priority", "category_code");



CREATE UNIQUE INDEX "idx_coupon_redemptions_active_per_subscription" ON "public"."coupon_redemptions" USING "btree" ("subscription_target", "applied_to_subscription_id") WHERE ("ended_at" IS NULL);



CREATE INDEX "idx_coupon_redemptions_coupon" ON "public"."coupon_redemptions" USING "btree" ("coupon_id", "redeemed_at" DESC);



CREATE INDEX "idx_coupons_code" ON "public"."coupons" USING "btree" ("code");



CREATE INDEX "idx_coupons_status" ON "public"."coupons" USING "btree" ("status", "valid_until");



CREATE INDEX "idx_dataset_ingredients_name_embedding_hnsw" ON "public"."dataset_ingredients" USING "hnsw" ("name_embedding" "extensions"."vector_cosine_ops");



CREATE INDEX "idx_dataset_ingredients_name_norm" ON "public"."dataset_ingredients" USING "btree" ("name_norm");



CREATE INDEX "idx_dataset_ingredients_name_trgm" ON "public"."dataset_ingredients" USING "gin" ("name_norm" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_dataset_menu_sets_embedding_hnsw" ON "public"."dataset_menu_sets" USING "hnsw" ("content_embedding" "extensions"."vector_cosine_ops");



CREATE INDEX "idx_dataset_menu_sets_meal_type_hint" ON "public"."dataset_menu_sets" USING "btree" ("meal_type_hint");



CREATE INDEX "idx_dataset_menu_sets_theme_tags" ON "public"."dataset_menu_sets" USING "gin" ("theme_tags");



CREATE INDEX "idx_dataset_recipes_name_embedding_hnsw" ON "public"."dataset_recipes" USING "hnsw" ("name_embedding" "extensions"."vector_cosine_ops");



CREATE INDEX "idx_dataset_recipes_name_norm" ON "public"."dataset_recipes" USING "btree" ("name_norm");



CREATE INDEX "idx_dataset_recipes_name_trgm" ON "public"."dataset_recipes" USING "gin" ("name_norm" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_departments_organization_id" ON "public"."departments" USING "btree" ("organization_id");



CREATE INDEX "idx_derived_recipes_base_dataset_recipe_id" ON "public"."derived_recipes" USING "btree" ("base_dataset_recipe_id");



CREATE INDEX "idx_derived_recipes_name_embedding_hnsw" ON "public"."derived_recipes" USING "hnsw" ("name_embedding" "extensions"."vector_cosine_ops");



CREATE INDEX "idx_derived_recipes_name_norm" ON "public"."derived_recipes" USING "btree" ("name_norm");



CREATE INDEX "idx_email_logs_email" ON "public"."email_delivery_logs" USING "btree" ("email", "sent_at" DESC);



CREATE INDEX "idx_email_logs_user" ON "public"."email_delivery_logs" USING "btree" ("user_id", "sent_at" DESC);



CREATE INDEX "idx_embedding_jobs_created_at" ON "public"."embedding_jobs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_embedding_jobs_job_id" ON "public"."embedding_jobs" USING "btree" ("job_id");



CREATE INDEX "idx_embedding_jobs_status" ON "public"."embedding_jobs" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_ext_consents_active" ON "public"."external_data_consents" USING "btree" ("user_id", "provider") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_failed_invites_ip" ON "public"."failed_invite_lookups" USING "btree" ("ip_address", "attempted_at" DESC);



CREATE INDEX "idx_family_groups_owner_id" ON "public"."legacy_family_groups" USING "btree" ("owner_id");



CREATE INDEX "idx_family_groups_representative" ON "public"."family_groups" USING "btree" ("representative_id");



CREATE INDEX "idx_family_groups_status" ON "public"."family_groups" USING "btree" ("status");



CREATE INDEX "idx_family_invites_token" ON "public"."family_invites" USING "btree" ("token");



CREATE INDEX "idx_family_meal_logs_family_member_id" ON "public"."family_meal_logs" USING "btree" ("family_member_id");



CREATE INDEX "idx_family_meal_logs_planned_meal_id" ON "public"."family_meal_logs" USING "btree" ("planned_meal_id");



CREATE INDEX "idx_family_members_family" ON "public"."family_members" USING "btree" ("family_id");



CREATE INDEX "idx_family_members_family_group_id" ON "public"."legacy_family_members" USING "btree" ("family_group_id");



CREATE INDEX "idx_family_members_user" ON "public"."family_members" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "idx_family_members_user_id" ON "public"."legacy_family_members" USING "btree" ("user_id");



CREATE INDEX "idx_family_promotion_requests_family" ON "public"."family_promotion_requests" USING "btree" ("family_id");



CREATE INDEX "idx_family_promotion_requests_member" ON "public"."family_promotion_requests" USING "btree" ("member_id");



CREATE INDEX "idx_health_challenges_active" ON "public"."health_challenges" USING "btree" ("user_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_health_challenges_user" ON "public"."health_challenges" USING "btree" ("user_id", "status");



CREATE INDEX "idx_health_checkups_user_date" ON "public"."health_checkups" USING "btree" ("user_id", "checkup_date" DESC);



CREATE INDEX "idx_health_goals_user" ON "public"."health_goals" USING "btree" ("user_id", "status");



CREATE INDEX "idx_health_goals_user_status" ON "public"."health_goals" USING "btree" ("user_id", "status");



CREATE INDEX "idx_health_goals_user_type" ON "public"."health_goals" USING "btree" ("user_id", "goal_type");



CREATE INDEX "idx_health_insights_alerts" ON "public"."health_insights" USING "btree" ("user_id") WHERE (("is_alert" = true) AND ("is_dismissed" = false));



CREATE INDEX "idx_health_insights_unread" ON "public"."health_insights" USING "btree" ("user_id") WHERE ("is_read" = false);



CREATE INDEX "idx_health_insights_user" ON "public"."health_insights" USING "btree" ("user_id", "analysis_date" DESC);



CREATE INDEX "idx_health_records_bp" ON "public"."health_records" USING "btree" ("user_id", "record_date") WHERE ("systolic_bp" IS NOT NULL);



CREATE INDEX "idx_health_records_user_date" ON "public"."health_records" USING "btree" ("user_id", "record_date" DESC);



CREATE INDEX "idx_health_records_weight" ON "public"."health_records" USING "btree" ("user_id", "record_date") WHERE ("weight" IS NOT NULL);



CREATE INDEX "idx_health_streaks_user" ON "public"."health_streaks" USING "btree" ("user_id");



CREATE INDEX "idx_health_streaks_user_type" ON "public"."health_streaks" USING "btree" ("user_id", "streak_type");



CREATE INDEX "idx_infra_metrics_cleanup" ON "public"."infra_metrics" USING "btree" ("recorded_at");



CREATE INDEX "idx_infra_metrics_recent" ON "public"."infra_metrics" USING "btree" ("metric_name", "recorded_at" DESC);



CREATE INDEX "idx_ingredient_match_cache_input_name" ON "public"."ingredient_match_cache" USING "btree" ("input_name");



CREATE INDEX "idx_inquiries_created_at" ON "public"."inquiries" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_inquiries_status" ON "public"."inquiries" USING "btree" ("status");



CREATE INDEX "idx_inquiries_user_id" ON "public"."inquiries" USING "btree" ("user_id");



CREATE INDEX "idx_iroca_meas_sample" ON "public"."iroca_measurements" USING "btree" ("sample_name");



CREATE INDEX "idx_iroca_plan_phase" ON "public"."iroca_experiment_plan" USING "btree" ("phase");



CREATE INDEX "idx_llm_usage_logs_created_at" ON "public"."llm_usage_logs" USING "btree" ("created_at");



CREATE INDEX "idx_llm_usage_logs_execution_id" ON "public"."llm_usage_logs" USING "btree" ("execution_id");



CREATE INDEX "idx_llm_usage_logs_function" ON "public"."llm_usage_logs" USING "btree" ("function_name");



CREATE INDEX "idx_llm_usage_logs_is_summary" ON "public"."llm_usage_logs" USING "btree" ("is_summary");



CREATE INDEX "idx_llm_usage_logs_request_id" ON "public"."llm_usage_logs" USING "btree" ("request_id");



CREATE INDEX "idx_llm_usage_logs_user_id" ON "public"."llm_usage_logs" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_longitudinal_review_user" ON "public"."health_checkup_longitudinal_reviews" USING "btree" ("user_id");



CREATE INDEX "idx_meal_ai_feedbacks_meal_id" ON "public"."meal_ai_feedbacks" USING "btree" ("meal_id");



CREATE INDEX "idx_meal_nutrition_debug_logs_created_at" ON "public"."meal_nutrition_debug_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_meal_nutrition_debug_logs_dish_name" ON "public"."meal_nutrition_debug_logs" USING "btree" ("dish_name");



CREATE INDEX "idx_meal_nutrition_debug_logs_issue_flags" ON "public"."meal_nutrition_debug_logs" USING "gin" ("issue_flags");



CREATE INDEX "idx_meal_nutrition_debug_logs_planned_meal_id" ON "public"."meal_nutrition_debug_logs" USING "btree" ("planned_meal_id");



CREATE INDEX "idx_meal_nutrition_debug_logs_request_id" ON "public"."meal_nutrition_debug_logs" USING "btree" ("request_id");



CREATE INDEX "idx_meal_nutrition_debug_logs_target_date_meal_type" ON "public"."meal_nutrition_debug_logs" USING "btree" ("target_date", "meal_type");



CREATE INDEX "idx_meal_nutrition_debug_logs_user_id_created_at" ON "public"."meal_nutrition_debug_logs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_meal_nutrition_estimates_meal_id" ON "public"."meal_nutrition_estimates" USING "btree" ("meal_id");



CREATE INDEX "idx_meals_eaten_at" ON "public"."meals" USING "btree" ("eaten_at");



CREATE INDEX "idx_meals_paste_group" ON "public"."meals" USING "btree" ("paste_group_id") WHERE ("paste_group_id" IS NOT NULL);



CREATE INDEX "idx_meals_user_id" ON "public"."meals" USING "btree" ("user_id");



CREATE INDEX "idx_meals_user_non_sandbox" ON "public"."meals" USING "btree" ("user_id", "eaten_at" DESC) WHERE ("is_sandbox" = false);



CREATE INDEX "idx_membership_audit_action" ON "public"."membership_audit" USING "btree" ("action");



CREATE INDEX "idx_membership_audit_actor" ON "public"."membership_audit" USING "btree" ("actor_id");



CREATE INDEX "idx_membership_audit_created_at" ON "public"."membership_audit" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_membership_audit_scope" ON "public"."membership_audit" USING "btree" ("scope", "scope_id");



CREATE INDEX "idx_membership_audit_target" ON "public"."membership_audit" USING "btree" ("target_user_id");



CREATE INDEX "idx_moderation_flags_meal_id" ON "public"."moderation_flags" USING "btree" ("meal_id");



CREATE INDEX "idx_moderation_flags_status" ON "public"."moderation_flags" USING "btree" ("status");



CREATE INDEX "idx_nps_surveys_recent" ON "public"."nps_surveys" USING "btree" ("sent_at" DESC);



CREATE INDEX "idx_nutrition_feedback_cache_user_date" ON "public"."nutrition_feedback_cache" USING "btree" ("user_id", "target_date");



CREATE INDEX "idx_nutrition_targets_user_id" ON "public"."nutrition_targets" USING "btree" ("user_id");



CREATE INDEX "idx_org_stats_date" ON "public"."org_daily_stats" USING "btree" ("date");



CREATE INDEX "idx_organization_challenge_participants_challenge_id" ON "public"."organization_challenge_participants" USING "btree" ("challenge_id");



CREATE INDEX "idx_organization_challenges_organization_id" ON "public"."organization_challenges" USING "btree" ("organization_id");



CREATE INDEX "idx_organization_invites_email" ON "public"."organization_invites" USING "btree" ("email");



CREATE INDEX "idx_organization_invites_token" ON "public"."organization_invites" USING "btree" ("token");



CREATE INDEX "idx_organization_reports_organization_id" ON "public"."organization_reports" USING "btree" ("organization_id");



CREATE INDEX "idx_organizations_owner_id" ON "public"."organizations" USING "btree" ("owner_id");



CREATE INDEX "idx_organizations_status" ON "public"."organizations" USING "btree" ("status") WHERE ("status" = 'dissolved'::"text");



CREATE INDEX "idx_ownership_transfer_from_user" ON "public"."ownership_transfer_proposals" USING "btree" ("from_user_id", "status");



CREATE INDEX "idx_ownership_transfer_to_user" ON "public"."ownership_transfer_proposals" USING "btree" ("to_user_id", "status");



CREATE INDEX "idx_pantry_items_expiration" ON "public"."pantry_items" USING "btree" ("expiration_date");



CREATE INDEX "idx_pantry_items_user_id" ON "public"."pantry_items" USING "btree" ("user_id");



CREATE INDEX "idx_password_history_user" ON "public"."password_history" USING "btree" ("user_id", "changed_at" DESC);



CREATE INDEX "idx_performance_checkins_user_date" ON "public"."user_performance_checkins" USING "btree" ("user_id", "checkin_date" DESC);



CREATE INDEX "idx_performance_plans_user_status" ON "public"."performance_plans" USING "btree" ("user_id", "status", "start_date" DESC);



CREATE UNIQUE INDEX "idx_personal_subscriptions_active_per_user" ON "public"."personal_subscriptions" USING "btree" ("user_id") WHERE (("status")::"text" = ANY ((ARRAY['trialing'::character varying, 'active'::character varying, 'paused'::character varying, 'past_due'::character varying, 'grace'::character varying])::"text"[]));



CREATE INDEX "idx_personal_subscriptions_status" ON "public"."personal_subscriptions" USING "btree" ("status");



CREATE INDEX "idx_personal_subscriptions_stripe_sub" ON "public"."personal_subscriptions" USING "btree" ("stripe_subscription_id") WHERE ("stripe_subscription_id" IS NOT NULL);



CREATE INDEX "idx_personal_subscriptions_trial_ending" ON "public"."personal_subscriptions" USING "btree" ("trial_ends_at") WHERE (("status")::"text" = 'trialing'::"text");



CREATE INDEX "idx_plan_price_history_plan" ON "public"."plan_price_history" USING "btree" ("plan_id", "created_at" DESC);



CREATE INDEX "idx_planned_meals_catalog_product_id" ON "public"."planned_meals" USING "btree" ("catalog_product_id");



CREATE INDEX "idx_planned_meals_daily_meal" ON "public"."planned_meals" USING "btree" ("daily_meal_id");



CREATE INDEX "idx_planned_meals_is_generating" ON "public"."planned_meals" USING "btree" ("is_generating") WHERE ("is_generating" = true);



CREATE INDEX "idx_planned_meals_source_menu_set_external_id" ON "public"."planned_meals" USING "btree" ("source_menu_set_external_id");



CREATE INDEX "idx_planned_meals_source_type" ON "public"."planned_meals" USING "btree" ("source_type");



CREATE INDEX "idx_recipe_collections_user_id" ON "public"."recipe_collections" USING "btree" ("user_id");



CREATE INDEX "idx_recipe_comments_recipe_id" ON "public"."recipe_comments" USING "btree" ("recipe_id");



CREATE INDEX "idx_recipe_flags_status" ON "public"."recipe_flags" USING "btree" ("status");



CREATE INDEX "idx_recipe_likes_recipe_id" ON "public"."recipe_likes" USING "btree" ("recipe_id");



CREATE INDEX "idx_recipe_likes_recipe_uuid" ON "public"."recipe_likes" USING "btree" ("recipe_uuid");



CREATE INDEX "idx_recipe_likes_user_id" ON "public"."recipe_likes" USING "btree" ("user_id");



CREATE INDEX "idx_recipe_requests_status" ON "public"."recipe_requests" USING "btree" ("status");



CREATE INDEX "idx_recipe_requests_user_id" ON "public"."recipe_requests" USING "btree" ("user_id");



CREATE INDEX "idx_recipes_category" ON "public"."recipes" USING "btree" ("category");



CREATE INDEX "idx_recipes_cuisine_type" ON "public"."recipes" USING "btree" ("cuisine_type");



CREATE INDEX "idx_recipes_difficulty" ON "public"."recipes" USING "btree" ("difficulty");



CREATE INDEX "idx_recipes_name" ON "public"."recipes" USING "btree" ("name");



CREATE INDEX "idx_recipes_user_id" ON "public"."recipes" USING "btree" ("user_id");



CREATE INDEX "idx_sales_leads_stage" ON "public"."sales_leads" USING "btree" ("stage", "assigned_to");



CREATE INDEX "idx_segment_stats_lookup" ON "public"."segment_stats" USING "btree" ("segment_id", "metric_id", "period_type", "period_start");



CREATE INDEX "idx_sessions_user" ON "public"."user_sessions_metadata" USING "btree" ("user_id", "last_active_at" DESC);



CREATE INDEX "idx_shopping_list_items_list" ON "public"."shopping_list_items" USING "btree" ("shopping_list_id");



CREATE INDEX "idx_shopping_list_items_source_new" ON "public"."shopping_list_items" USING "btree" ("shopping_list_id", "source");



CREATE INDEX "idx_shopping_list_requests_created" ON "public"."shopping_list_requests" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_shopping_list_requests_meal_plan_id" ON "public"."shopping_list_requests" USING "btree" ("meal_plan_id");



CREATE INDEX "idx_shopping_list_requests_shopping_list_id" ON "public"."shopping_list_requests" USING "btree" ("shopping_list_id");



CREATE INDEX "idx_shopping_list_requests_status" ON "public"."shopping_list_requests" USING "btree" ("status");



CREATE INDEX "idx_shopping_list_requests_user" ON "public"."shopping_list_requests" USING "btree" ("user_id");



CREATE INDEX "idx_shopping_list_requests_user_id" ON "public"."shopping_list_requests" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_shopping_lists_active_unique" ON "public"."shopping_lists" USING "btree" ("user_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_shopping_lists_dates" ON "public"."shopping_lists" USING "btree" ("start_date", "end_date");



CREATE INDEX "idx_shopping_lists_user_status" ON "public"."shopping_lists" USING "btree" ("user_id", "status");



CREATE INDEX "idx_stripe_webhook_status" ON "public"."stripe_webhook_events" USING "btree" ("processing_status", "received_at");



CREATE INDEX "idx_subscription_plans_status" ON "public"."subscription_plans" USING "btree" ("status", "display_order");



CREATE INDEX "idx_subscription_plans_type" ON "public"."subscription_plans" USING "btree" ("plan_type", "status");



CREATE INDEX "idx_support_tickets_assignee" ON "public"."support_tickets" USING "btree" ("assignee_id", "status");



CREATE INDEX "idx_support_tickets_status" ON "public"."support_tickets" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_support_tickets_user" ON "public"."support_tickets" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_system_daily_stats_date" ON "public"."system_daily_stats" USING "btree" ("date" DESC);



CREATE INDEX "idx_terms_acceptances_user" ON "public"."terms_acceptances" USING "btree" ("user_id", "document_type", "document_version");



CREATE INDEX "idx_ticket_messages_ticket" ON "public"."support_ticket_messages" USING "btree" ("ticket_id", "created_at");



CREATE INDEX "idx_user_badges_user_id" ON "public"."user_badges" USING "btree" ("user_id");



CREATE INDEX "idx_user_daily_meals_day_date" ON "public"."user_daily_meals" USING "btree" ("day_date");



CREATE INDEX "idx_user_daily_meals_user_date" ON "public"."user_daily_meals" USING "btree" ("user_id", "day_date");



CREATE INDEX "idx_user_metrics_lookup" ON "public"."user_metrics" USING "btree" ("user_id", "period_type", "period_start");



CREATE INDEX "idx_user_metrics_metric_period" ON "public"."user_metrics" USING "btree" ("metric_id", "period_type", "period_start");



CREATE INDEX "idx_user_profiles_department" ON "public"."user_profiles" USING "btree" ("department_id") WHERE ("department_id" IS NOT NULL);



CREATE INDEX "idx_user_profiles_family" ON "public"."user_profiles" USING "btree" ("family_id") WHERE ("family_id" IS NOT NULL);



CREATE INDEX "idx_user_profiles_frozen" ON "public"."user_profiles" USING "btree" ("id") WHERE ("frozen_at" IS NOT NULL);



CREATE INDEX "idx_user_profiles_handson_tour_pending" ON "public"."user_profiles" USING "btree" ("id") WHERE (("handson_tour_completed_at" IS NULL) AND ("handson_tour_skipped_at" IS NULL));



CREATE INDEX "idx_user_profiles_org" ON "public"."user_profiles" USING "btree" ("organization_id") WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_user_profiles_org_id" ON "public"."user_profiles" USING "btree" ("organization_id");



CREATE INDEX "idx_user_profiles_roles" ON "public"."user_profiles" USING "gin" ("roles");



CREATE INDEX "idx_user_push_tokens_user_id" ON "public"."user_push_tokens" USING "btree" ("user_id");



CREATE INDEX "idx_user_segment_rankings_lookup" ON "public"."user_segment_rankings" USING "btree" ("user_id", "period_type", "period_start");



CREATE INDEX "idx_weekly_menu_requests_exceeded_attempts" ON "public"."weekly_menu_requests" USING "btree" ("updated_at") WHERE (("status" = 'queued'::"text") AND ("attempt_count" >= 3));



CREATE INDEX "idx_weekly_menu_requests_mode" ON "public"."weekly_menu_requests" USING "btree" ("mode");



CREATE INDEX "idx_weekly_menu_requests_queued" ON "public"."weekly_menu_requests" USING "btree" ("created_at") WHERE ("status" = 'queued'::"text");



CREATE INDEX "idx_weekly_menu_requests_status" ON "public"."weekly_menu_requests" USING "btree" ("status");



CREATE INDEX "idx_weekly_menu_requests_status_user" ON "public"."weekly_menu_requests" USING "btree" ("user_id", "status");



CREATE INDEX "idx_weekly_menu_requests_updated_at" ON "public"."weekly_menu_requests" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_weekly_menu_requests_user_id" ON "public"."weekly_menu_requests" USING "btree" ("user_id");



CREATE INDEX "idx_weekly_menus_request_id" ON "public"."weekly_menus" USING "btree" ("request_id");



CREATE INDEX "idx_weekly_menus_user_id" ON "public"."weekly_menus" USING "btree" ("user_id");



CREATE INDEX "llm_usage_logs_created_at_idx" ON "public"."llm_usage_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "llm_usage_logs_execution_id_idx" ON "public"."llm_usage_logs" USING "btree" ("execution_id");



CREATE INDEX "llm_usage_logs_function_name_created_at_idx" ON "public"."llm_usage_logs" USING "btree" ("function_name", "created_at" DESC);



CREATE INDEX "llm_usage_logs_model_created_at_idx" ON "public"."llm_usage_logs" USING "btree" ("model", "created_at" DESC);



CREATE INDEX "llm_usage_logs_user_id_created_at_idx" ON "public"."llm_usage_logs" USING "btree" ("user_id", "created_at" DESC);



CREATE UNIQUE INDEX "meal_image_jobs_idempotency_pending_idx" ON "public"."meal_image_jobs" USING "btree" ("idempotency_key") WHERE ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"]));



CREATE INDEX "meal_image_jobs_planned_meal_dish_idx" ON "public"."meal_image_jobs" USING "btree" ("planned_meal_id", "dish_index");



CREATE INDEX "meal_image_jobs_status_priority_created_idx" ON "public"."meal_image_jobs" USING "btree" ("status", "priority" DESC, "created_at");



CREATE INDEX "meal_image_jobs_user_created_idx" ON "public"."meal_image_jobs" USING "btree" ("user_id", "created_at" DESC);



CREATE UNIQUE INDEX "uniq_family_invites_pending" ON "public"."family_invites" USING "btree" ("family_id", "lower"("email")) WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uniq_family_members_user" ON "public"."family_members" USING "btree" ("user_id") WHERE (("user_id" IS NOT NULL) AND ("status" = 'active'::"text"));



CREATE UNIQUE INDEX "uniq_family_promotion_pending_member" ON "public"."family_promotion_requests" USING "btree" ("member_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uniq_family_representative" ON "public"."family_members" USING "btree" ("family_id") WHERE (("role" = 'representative'::"public"."family_role_enum") AND ("status" = 'active'::"text"));



CREATE UNIQUE INDEX "uniq_org_invites_pending" ON "public"."organization_invites" USING "btree" ("organization_id", "lower"("email")) WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uniq_org_invites_token" ON "public"."organization_invites" USING "btree" ("token");



CREATE UNIQUE INDEX "uniq_ownership_transfer_pending" ON "public"."ownership_transfer_proposals" USING "btree" ("scope", "scope_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uniq_user_sandbox_daily_meal" ON "public"."user_daily_meals" USING "btree" ("user_id") WHERE ("is_sandbox" = true);



CREATE UNIQUE INDEX "uniq_user_sandbox_meal" ON "public"."meals" USING "btree" ("user_id") WHERE ("is_sandbox" = true);



CREATE UNIQUE INDEX "uq_dataset_ingredients_name_norm" ON "public"."dataset_ingredients" USING "btree" ("name_norm");



CREATE UNIQUE INDEX "user_push_tokens_user_token_uniq" ON "public"."user_push_tokens" USING "btree" ("user_id", "expo_push_token");



CREATE OR REPLACE TRIGGER "nutrition_feedback_cache_updated_at" BEFORE UPDATE ON "public"."nutrition_feedback_cache" FOR EACH ROW EXECUTE FUNCTION "public"."update_nutrition_feedback_cache_updated_at"();



CREATE OR REPLACE TRIGGER "trg_fill_derived_recipes_magnesium_mg" BEFORE INSERT OR UPDATE ON "public"."derived_recipes" FOR EACH ROW EXECUTE FUNCTION "public"."fill_derived_recipes_magnesium_mg"();



CREATE OR REPLACE TRIGGER "trg_fill_planned_meals_magnesium_mg" BEFORE INSERT OR UPDATE ON "public"."planned_meals" FOR EACH ROW EXECUTE FUNCTION "public"."fill_planned_meals_magnesium_mg"();



CREATE OR REPLACE TRIGGER "trg_guard_family_groups_privileged" BEFORE UPDATE ON "public"."family_groups" FOR EACH ROW EXECUTE FUNCTION "public"."guard_family_groups_privileged"();



CREATE OR REPLACE TRIGGER "trg_guard_family_members_privileged" BEFORE UPDATE ON "public"."family_members" FOR EACH ROW EXECUTE FUNCTION "public"."guard_family_members_privileged"();



CREATE OR REPLACE TRIGGER "trg_guard_organizations_privileged" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."guard_organizations_privileged"();



CREATE OR REPLACE TRIGGER "trg_guard_user_profiles_privileged" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_user_profiles_privileged"();



CREATE OR REPLACE TRIGGER "trg_guard_user_profiles_privileged_on_insert" BEFORE INSERT ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_user_profiles_privileged_on_insert"();



CREATE OR REPLACE TRIGGER "trg_pantry_items_updated_at" BEFORE UPDATE ON "public"."pantry_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_planned_meals_updated_at" BEFORE UPDATE ON "public"."planned_meals" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_recipes_updated_at" BEFORE UPDATE ON "public"."recipes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_shopping_list_items_updated_at" BEFORE UPDATE ON "public"."shopping_list_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_sport_presets_updated_at" BEFORE UPDATE ON "public"."sport_presets" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trg_sync_recipe_like_count" AFTER INSERT OR DELETE ON "public"."recipe_likes" FOR EACH ROW EXECUTE FUNCTION "public"."sync_recipe_like_count"();



CREATE OR REPLACE TRIGGER "trg_update_performance_checkin_timestamp" BEFORE UPDATE ON "public"."user_performance_checkins" FOR EACH ROW EXECUTE FUNCTION "public"."update_performance_checkin_timestamp"();



CREATE OR REPLACE TRIGGER "trg_update_performance_plan_timestamp" BEFORE UPDATE ON "public"."performance_plans" FOR EACH ROW EXECUTE FUNCTION "public"."update_performance_checkin_timestamp"();



CREATE OR REPLACE TRIGGER "trigger_ai_consultation_sessions_updated_at" BEFORE UPDATE ON "public"."ai_consultation_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_ai_consultation_sessions_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_catalog_import_runs_updated_at" BEFORE UPDATE ON "public"."catalog_import_runs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_catalog_products_updated_at" BEFORE UPDATE ON "public"."catalog_products" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_catalog_source_categories_updated_at" BEFORE UPDATE ON "public"."catalog_source_categories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_catalog_sources_updated_at" BEFORE UPDATE ON "public"."catalog_sources" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_dataset_ingredients_updated_at" BEFORE UPDATE ON "public"."dataset_ingredients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_dataset_menu_sets_updated_at" BEFORE UPDATE ON "public"."dataset_menu_sets" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_dataset_recipes_updated_at" BEFORE UPDATE ON "public"."dataset_recipes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_derived_recipes_updated_at" BEFORE UPDATE ON "public"."derived_recipes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "trigger_family_groups_updated_at" BEFORE UPDATE ON "public"."legacy_family_groups" FOR EACH ROW EXECUTE FUNCTION "public"."update_family_groups_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_family_members_updated_at" BEFORE UPDATE ON "public"."legacy_family_members" FOR EACH ROW EXECUTE FUNCTION "public"."update_family_members_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_health_checkups_updated_at" BEFORE UPDATE ON "public"."health_checkups" FOR EACH ROW EXECUTE FUNCTION "public"."update_health_checkups_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_health_goals_updated_at" BEFORE UPDATE ON "public"."health_goals" FOR EACH ROW EXECUTE FUNCTION "public"."update_health_goals_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_health_records_updated_at" BEFORE UPDATE ON "public"."health_records" FOR EACH ROW EXECUTE FUNCTION "public"."update_health_records_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_health_streaks_updated_at" BEFORE UPDATE ON "public"."health_streaks" FOR EACH ROW EXECUTE FUNCTION "public"."update_health_streaks_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_inquiries_updated_at" BEFORE UPDATE ON "public"."inquiries" FOR EACH ROW EXECUTE FUNCTION "public"."update_inquiries_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_nutrition_targets_updated_at" BEFORE UPDATE ON "public"."nutrition_targets" FOR EACH ROW EXECUTE FUNCTION "public"."update_nutrition_targets_updated_at"();



CREATE OR REPLACE TRIGGER "trigger_shopping_list_requests_updated_at" BEFORE UPDATE ON "public"."shopping_list_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_shopping_list_requests_updated_at"();



CREATE OR REPLACE TRIGGER "update_embedding_jobs_updated_at" BEFORE UPDATE ON "public"."embedding_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."update_embedding_jobs_updated_at"();



ALTER TABLE ONLY "public"."admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_impersonated_by_fkey" FOREIGN KEY ("impersonated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."ai_consultation_messages"("id");



ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_consultation_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_consultation_messages"
    ADD CONSTRAINT "ai_consultation_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_consultation_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_consultation_sessions"
    ADD CONSTRAINT "ai_consultation_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_content_logs"
    ADD CONSTRAINT "ai_content_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."app_logs"
    ADD CONSTRAINT "app_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."blood_test_longitudinal_reviews"
    ADD CONSTRAINT "blood_test_longitudinal_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blood_test_results"
    ADD CONSTRAINT "blood_test_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_1_fkey" FOREIGN KEY ("user_id_1") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_2_fkey" FOREIGN KEY ("user_id_2") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."catalog_import_runs"
    ADD CONSTRAINT "catalog_import_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."catalog_product_snapshots"
    ADD CONSTRAINT "catalog_product_snapshots_import_run_id_fkey" FOREIGN KEY ("import_run_id") REFERENCES "public"."catalog_import_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."catalog_product_snapshots"
    ADD CONSTRAINT "catalog_product_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."catalog_products"
    ADD CONSTRAINT "catalog_products_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."catalog_raw_documents"
    ADD CONSTRAINT "catalog_raw_documents_import_run_id_fkey" FOREIGN KEY ("import_run_id") REFERENCES "public"."catalog_import_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."catalog_raw_documents"
    ADD CONSTRAINT "catalog_raw_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."catalog_source_categories"
    ADD CONSTRAINT "catalog_source_categories_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cookie_consents"
    ADD CONSTRAINT "cookie_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."csat_feedbacks"
    ADD CONSTRAINT "csat_feedbacks_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id");



ALTER TABLE ONLY "public"."csat_feedbacks"
    ADD CONSTRAINT "csat_feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."derived_recipes"
    ADD CONSTRAINT "derived_recipes_base_dataset_recipe_id_fkey" FOREIGN KEY ("base_dataset_recipe_id") REFERENCES "public"."dataset_recipes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."derived_recipes"
    ADD CONSTRAINT "derived_recipes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_blacklist"
    ADD CONSTRAINT "email_blacklist_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."email_delivery_logs"
    ADD CONSTRAINT "email_delivery_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id");



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."external_data_consents"
    ADD CONSTRAINT "external_data_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."legacy_family_groups"
    ADD CONSTRAINT "family_groups_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_groups"
    ADD CONSTRAINT "family_groups_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "public"."subscription_plans"("plan_key");



ALTER TABLE ONLY "public"."family_groups"
    ADD CONSTRAINT "family_groups_representative_id_fkey" FOREIGN KEY ("representative_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."family_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_family_member_id_fkey" FOREIGN KEY ("family_member_id") REFERENCES "public"."legacy_family_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_planned_meal_id_fkey" FOREIGN KEY ("planned_meal_id") REFERENCES "public"."planned_meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_family_group_id_fkey" FOREIGN KEY ("family_group_id") REFERENCES "public"."legacy_family_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."family_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_user_id_fkey1" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."family_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."family_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_promotion_requests"
    ADD CONSTRAINT "family_promotion_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."gdpr_deletion_requests"
    ADD CONSTRAINT "gdpr_deletion_requests_executed_by_fkey" FOREIGN KEY ("executed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."gdpr_deletion_requests"
    ADD CONSTRAINT "gdpr_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."health_challenges"
    ADD CONSTRAINT "health_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_checkup_longitudinal_reviews"
    ADD CONSTRAINT "health_checkup_longitudinal_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_checkups"
    ADD CONSTRAINT "health_checkups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_goals"
    ADD CONSTRAINT "health_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_insights"
    ADD CONSTRAINT "health_insights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_records"
    ADD CONSTRAINT "health_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_streaks"
    ADD CONSTRAINT "health_streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."help_articles"
    ADD CONSTRAINT "help_articles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."infra_alerts"
    ADD CONSTRAINT "infra_alerts_ack_by_fkey" FOREIGN KEY ("ack_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ingredient_match_cache"
    ADD CONSTRAINT "ingredient_match_cache_matched_ingredient_id_fkey" FOREIGN KEY ("matched_ingredient_id") REFERENCES "public"."dataset_ingredients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inquiries"
    ADD CONSTRAINT "inquiries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_ai_feedbacks"
    ADD CONSTRAINT "meal_ai_feedbacks_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meal_image_jobs"
    ADD CONSTRAINT "meal_image_jobs_planned_meal_id_fkey" FOREIGN KEY ("planned_meal_id") REFERENCES "public"."planned_meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meal_nutrition_debug_logs"
    ADD CONSTRAINT "meal_nutrition_debug_logs_daily_meal_id_fkey" FOREIGN KEY ("daily_meal_id") REFERENCES "public"."user_daily_meals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_nutrition_debug_logs"
    ADD CONSTRAINT "meal_nutrition_debug_logs_planned_meal_id_fkey" FOREIGN KEY ("planned_meal_id") REFERENCES "public"."planned_meals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_nutrition_debug_logs"
    ADD CONSTRAINT "meal_nutrition_debug_logs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."weekly_menu_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_nutrition_debug_logs"
    ADD CONSTRAINT "meal_nutrition_debug_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_nutrition_estimates"
    ADD CONSTRAINT "meal_nutrition_estimates_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meals"
    ADD CONSTRAINT "meals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership_audit"
    ADD CONSTRAINT "membership_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."membership_audit"
    ADD CONSTRAINT "membership_audit_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nps_surveys"
    ADD CONSTRAINT "nps_surveys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_license_pools"
    ADD CONSTRAINT "org_license_pools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "public"."organization_challenges"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organization_reports"
    ADD CONSTRAINT "organization_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ownership_transfer_proposals"
    ADD CONSTRAINT "ownership_transfer_proposals_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ownership_transfer_proposals"
    ADD CONSTRAINT "ownership_transfer_proposals_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."password_history"
    ADD CONSTRAINT "password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."performance_plans"
    ADD CONSTRAINT "performance_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."personal_subscriptions"
    ADD CONSTRAINT "personal_subscriptions_active_coupon_redemption_id_fkey" FOREIGN KEY ("active_coupon_redemption_id") REFERENCES "public"."coupon_redemptions"("id");



ALTER TABLE ONLY "public"."personal_subscriptions"
    ADD CONSTRAINT "personal_subscriptions_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "public"."subscription_plans"("plan_key") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."personal_subscriptions"
    ADD CONSTRAINT "personal_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plan_price_history"
    ADD CONSTRAINT "plan_price_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."plan_price_history"
    ADD CONSTRAINT "plan_price_history_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planned_meals"
    ADD CONSTRAINT "planned_meals_actual_meal_id_fkey" FOREIGN KEY ("actual_meal_id") REFERENCES "public"."meals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."planned_meals"
    ADD CONSTRAINT "planned_meals_catalog_product_id_fkey" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."planned_meals"
    ADD CONSTRAINT "planned_meals_daily_meal_id_fkey" FOREIGN KEY ("daily_meal_id") REFERENCES "public"."user_daily_meals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."recipe_collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_collections"
    ADD CONSTRAINT "recipe_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."recipe_likes"
    ADD CONSTRAINT "recipe_likes_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_likes"
    ADD CONSTRAINT "recipe_likes_recipe_uuid_fkey" FOREIGN KEY ("recipe_uuid") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_likes"
    ADD CONSTRAINT "recipe_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_requests"
    ADD CONSTRAINT "recipe_requests_base_meal_id_fkey" FOREIGN KEY ("base_meal_id") REFERENCES "public"."meals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."recipe_requests"
    ADD CONSTRAINT "recipe_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referral_rewards"
    ADD CONSTRAINT "referral_rewards_referred_id_fkey" FOREIGN KEY ("referred_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."referral_rewards"
    ADD CONSTRAINT "referral_rewards_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sales_lead_activities"
    ADD CONSTRAINT "sales_lead_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sales_lead_activities"
    ADD CONSTRAINT "sales_lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."sales_leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_leads"
    ADD CONSTRAINT "sales_leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segment_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_shopping_list_id_fkey" FOREIGN KEY ("shopping_list_id") REFERENCES "public"."shopping_lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_list_requests"
    ADD CONSTRAINT "shopping_list_requests_shopping_list_id_fkey" FOREIGN KEY ("shopping_list_id") REFERENCES "public"."shopping_lists"("id");



ALTER TABLE ONLY "public"."shopping_list_requests"
    ADD CONSTRAINT "shopping_list_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_superseded_by_plan_id_fkey" FOREIGN KEY ("superseded_by_plan_id") REFERENCES "public"."subscription_plans"("id");



ALTER TABLE ONLY "public"."support_ticket_messages"
    ADD CONSTRAINT "support_ticket_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."support_ticket_messages"
    ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_daily_meals"
    ADD CONSTRAINT "user_daily_meals_source_request_id_fkey" FOREIGN KEY ("source_request_id") REFERENCES "public"."weekly_menu_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_daily_meals"
    ADD CONSTRAINT "user_daily_meals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_performance_checkins"
    ADD CONSTRAINT "user_performance_checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."family_groups"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_frozen_by_fkey" FOREIGN KEY ("frozen_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_push_tokens"
    ADD CONSTRAINT "user_push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segment_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_sessions_metadata"
    ADD CONSTRAINT "user_sessions_metadata_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weekly_menu_requests"
    ADD CONSTRAINT "weekly_menu_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."weekly_menu_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can create audit logs" ON "public"."admin_audit_logs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));



CREATE POLICY "Admins can manage announcements" ON "public"."announcements" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));



CREATE POLICY "Admins can manage user notes" ON "public"."admin_user_notes" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));



CREATE POLICY "Admins can update inquiries" ON "public"."inquiries" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));



CREATE POLICY "Admins can update recipe flags" ON "public"."recipe_flags" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));



CREATE POLICY "Admins can view all inquiries" ON "public"."inquiries" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"]))))));



CREATE POLICY "Admins can view audit logs" ON "public"."admin_audit_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));



CREATE POLICY "Admins can view system settings" ON "public"."system_settings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));



CREATE POLICY "Admins can view system stats" ON "public"."system_daily_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));



CREATE POLICY "Allow all on iroca_experiment_plan" ON "public"."iroca_experiment_plan" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on iroca_measurements" ON "public"."iroca_measurements" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on iroca_sample_summary" ON "public"."iroca_sample_summary" USING (true) WITH CHECK (true);



CREATE POLICY "Allow anon users to read dataset_ingredients" ON "public"."dataset_ingredients" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Allow authenticated users to read dataset_ingredients" ON "public"."dataset_ingredients" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Allow service role access" ON "public"."ingredient_match_cache" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Anyone can create inquiries" ON "public"."inquiries" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "Anyone can create recipe flags" ON "public"."recipe_flags" FOR INSERT TO "authenticated" WITH CHECK (("reporter_id" = "auth"."uid"()));



CREATE POLICY "Anyone can view badges" ON "public"."badges" FOR SELECT USING (true);



CREATE POLICY "Anyone can view comments" ON "public"."recipe_comments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Anyone can view likes" ON "public"."recipe_likes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Anyone can view public collection items" ON "public"."recipe_collection_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND (("recipe_collections"."is_public" = true) OR ("recipe_collections"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Anyone can view public collections" ON "public"."recipe_collections" FOR SELECT TO "authenticated" USING ((("is_public" = true) OR ("user_id" = "auth"."uid"())));



CREATE POLICY "Org admins can manage challenges" ON "public"."organization_challenges" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_challenges"."organization_id") AND (("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])) OR ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Org admins can manage departments" ON "public"."departments" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "departments"."organization_id") AND (("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])) OR ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Org admins can manage invites" ON "public"."organization_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND (("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])) OR ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Org admins can manage reports" ON "public"."organization_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_reports"."organization_id") AND (("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])) OR ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Org admins can view own stats" ON "public"."org_daily_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "org_daily_stats"."organization_id") AND (("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])) OR ("up"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Org members can view challenges" ON "public"."organization_challenges" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_challenges"."organization_id")))));



CREATE POLICY "Org members can view departments" ON "public"."departments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "departments"."organization_id")))));



CREATE POLICY "Org members can view participants" ON "public"."organization_challenge_participants" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."organization_challenges" "oc"
     JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "oc"."organization_id")))
  WHERE (("oc"."id" = "organization_challenge_participants"."challenge_id") AND ("up"."id" = "auth"."uid"())))));



CREATE POLICY "Org members can view reports" ON "public"."organization_reports" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_reports"."organization_id")))));



CREATE POLICY "Public announcements are viewable by everyone" ON "public"."announcements" FOR SELECT USING (("is_public" = true));



CREATE POLICY "Service role can do everything" ON "public"."app_logs" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role can do everything" ON "public"."embedding_jobs" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role can do everything" ON "public"."llm_usage_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can do everything on meal_nutrition_debug_logs" ON "public"."meal_nutrition_debug_logs" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Super admin can view" ON "public"."embedding_jobs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "Super admins can update system settings" ON "public"."system_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "Users and admins can view ai logs" ON "public"."ai_content_logs" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Users and admins can view recipe flags" ON "public"."recipe_flags" FOR SELECT USING ((("reporter_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));



CREATE POLICY "Users can create comments" ON "public"."recipe_comments" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can create own shopping list requests" ON "public"."shopping_list_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create their own requests" ON "public"."weekly_menu_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own blood test results" ON "public"."blood_test_results" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own checkups" ON "public"."health_checkups" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own comments" ON "public"."recipe_comments" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete own health goals" ON "public"."health_goals" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own health records" ON "public"."health_records" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own health streaks" ON "public"."health_streaks" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own recipe likes" ON "public"."recipe_likes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own blood test longitudinal reviews" ON "public"."blood_test_longitudinal_reviews" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own blood test results" ON "public"."blood_test_results" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own checkups" ON "public"."health_checkups" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own health challenges" ON "public"."health_challenges" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own health goals" ON "public"."health_goals" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own health records" ON "public"."health_records" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own health streaks" ON "public"."health_streaks" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own longitudinal reviews" ON "public"."health_checkup_longitudinal_reviews" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own notification preferences" ON "public"."notification_preferences" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own nutrition targets" ON "public"."nutrition_targets" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own profile" ON "public"."user_profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert own recipe likes" ON "public"."recipe_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can join challenges" ON "public"."organization_challenge_participants" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM ("public"."organization_challenges" "oc"
     JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "oc"."organization_id")))
  WHERE (("oc"."id" = "organization_challenge_participants"."challenge_id") AND ("up"."id" = ( SELECT "auth"."uid"() AS "uid"))))) AND (COALESCE("current_value", (0)::numeric) = (0)::numeric) AND ("rank" IS NULL)));



CREATE POLICY "Users can manage actions in own sessions" ON "public"."ai_action_logs" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_action_logs"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_action_logs"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage logs for own family members" ON "public"."family_meal_logs" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."legacy_family_members" "fm"
     JOIN "public"."legacy_family_groups" "fg" ON (("fm"."family_group_id" = "fg"."id")))
  WHERE (("fm"."id" = "family_meal_logs"."family_member_id") AND ("fg"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."legacy_family_members" "fm"
     JOIN "public"."legacy_family_groups" "fg" ON (("fm"."family_group_id" = "fg"."id")))
  WHERE (("fm"."id" = "family_meal_logs"."family_member_id") AND ("fg"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage members in own family groups" ON "public"."legacy_family_members" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."legacy_family_groups"
  WHERE (("legacy_family_groups"."id" = "legacy_family_members"."family_group_id") AND ("legacy_family_groups"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."legacy_family_groups"
  WHERE (("legacy_family_groups"."id" = "legacy_family_members"."family_group_id") AND ("legacy_family_groups"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage messages in own sessions" ON "public"."ai_consultation_messages" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_consultation_messages"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_consultation_messages"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own actions" ON "public"."buddy_actions" USING (("auth"."uid"() = "from_user_id"));



CREATE POLICY "Users can manage own activity" ON "public"."daily_activity_logs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own announcement reads" ON "public"."announcement_reads" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own collection items" ON "public"."recipe_collection_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND ("recipe_collections"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND ("recipe_collections"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own collections" ON "public"."recipe_collections" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own daily meals" ON "public"."user_daily_meals" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own family groups" ON "public"."legacy_family_groups" TO "authenticated" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own likes" ON "public"."recipe_likes" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own nutrition feedback cache" ON "public"."nutrition_feedback_cache" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own pantry items" ON "public"."pantry_items" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own performance checkins" ON "public"."user_performance_checkins" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own performance plans" ON "public"."performance_plans" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own planned meals" ON "public"."planned_meals" USING ((EXISTS ( SELECT 1
   FROM "public"."user_daily_meals"
  WHERE (("user_daily_meals"."id" = "planned_meals"."daily_meal_id") AND ("user_daily_meals"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own recipe requests" ON "public"."recipe_requests" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own recipes" ON "public"."recipes" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own sessions" ON "public"."ai_consultation_sessions" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own shopping list" ON "public"."shopping_list_items" USING ((EXISTS ( SELECT 1
   FROM "public"."shopping_lists"
  WHERE (("shopping_lists"."id" = "shopping_list_items"."shopping_list_id") AND ("shopping_lists"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own shopping list requests" ON "public"."shopping_list_requests" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own shopping lists" ON "public"."shopping_lists" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own weekly menu requests" ON "public"."weekly_menu_requests" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own logs" ON "public"."app_logs" FOR SELECT USING ((("auth"."uid"() = "user_id") OR ("user_id" IS NULL)));



CREATE POLICY "Users can select own llm usage logs" ON "public"."llm_usage_logs" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can select own nutrition feedback cache" ON "public"."nutrition_feedback_cache" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own blood test longitudinal reviews" ON "public"."blood_test_longitudinal_reviews" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own blood test results" ON "public"."blood_test_results" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own checkups" ON "public"."health_checkups" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own comments" ON "public"."recipe_comments" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own health challenges" ON "public"."health_challenges" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own health goals" ON "public"."health_goals" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own health insights" ON "public"."health_insights" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own health records" ON "public"."health_records" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own health streaks" ON "public"."health_streaks" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own longitudinal reviews" ON "public"."health_checkup_longitudinal_reviews" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own notification preferences" ON "public"."notification_preferences" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own nutrition targets" ON "public"."nutrition_targets" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own profile" ON "public"."user_profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own badges" ON "public"."user_badges" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own blood test longitudinal reviews" ON "public"."blood_test_longitudinal_reviews" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own blood test results" ON "public"."blood_test_results" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own buddies" ON "public"."buddies" FOR SELECT USING ((("auth"."uid"() = "user_id_1") OR ("auth"."uid"() = "user_id_2")));



CREATE POLICY "Users can view own checkups" ON "public"."health_checkups" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own feedbacks" ON "public"."meal_ai_feedbacks" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."meals"
  WHERE (("meals"."id" = "meal_ai_feedbacks"."meal_id") AND ("meals"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own health challenges" ON "public"."health_challenges" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own health goals" ON "public"."health_goals" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own health insights" ON "public"."health_insights" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own health records" ON "public"."health_records" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own health streaks" ON "public"."health_streaks" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own inquiries" ON "public"."inquiries" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view own logs" ON "public"."app_logs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own longitudinal reviews" ON "public"."health_checkup_longitudinal_reviews" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own meal_nutrition_debug_logs" ON "public"."meal_nutrition_debug_logs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own notification preferences" ON "public"."notification_preferences" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own nutrition estimates" ON "public"."meal_nutrition_estimates" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."meals"
  WHERE (("meals"."id" = "meal_nutrition_estimates"."meal_id") AND ("meals"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own nutrition targets" ON "public"."nutrition_targets" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view own profile" ON "public"."user_profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own recipe likes" ON "public"."recipe_likes" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own shopping list requests" ON "public"."shopping_list_requests" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view public recipes" ON "public"."recipes" FOR SELECT USING ((("user_id" IS NULL) OR ("is_public" = true) OR ("auth"."uid"() = "user_id")));



CREATE POLICY "Users can view their own menus" ON "public"."weekly_menus" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own requests" ON "public"."weekly_menu_requests" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."admin_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_user_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_action_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_consultation_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_consultation_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_content_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."announcement_reads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_insert_admins" ON "public"."admin_audit_logs" FOR INSERT WITH CHECK ((("actor_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text", 'sales'::"text", 'finance'::"text", 'content_moderator'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "audit_logs_no_delete" ON "public"."admin_audit_logs" FOR DELETE USING (false);



CREATE POLICY "audit_logs_no_update" ON "public"."admin_audit_logs" FOR UPDATE USING (false);



CREATE POLICY "audit_logs_select_super_admin" ON "public"."admin_audit_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



ALTER TABLE "public"."badges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blood_test_longitudinal_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blood_test_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."buddies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."buddy_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."catalog_import_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_import_runs_service_role_all" ON "public"."catalog_import_runs" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."catalog_product_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_product_snapshots_service_role_all" ON "public"."catalog_product_snapshots" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."catalog_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_products_select_all" ON "public"."catalog_products" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."catalog_raw_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_raw_documents_service_role_all" ON "public"."catalog_raw_documents" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."catalog_source_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_source_categories_select_all" ON "public"."catalog_source_categories" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."catalog_sources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "catalog_sources_select_all" ON "public"."catalog_sources" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."cookie_consents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cookie_consents_self" ON "public"."cookie_consents" USING ((("auth"."uid"() = "user_id") OR ("user_id" IS NULL)));



ALTER TABLE "public"."coupon_redemptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coupon_redemptions_select" ON "public"."coupon_redemptions" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['finance'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



ALTER TABLE "public"."coupons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coupons_mutate_sales_or_above" ON "public"."coupons" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['sales'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "coupons_select_sales_or_above" ON "public"."coupons" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['sales'::"text", 'finance'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "csat_access" ON "public"."csat_feedbacks" USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



ALTER TABLE "public"."csat_feedbacks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_active_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_activity_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dataset_import_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dataset_ingredients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dataset_menu_sets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dataset_recipes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dataset_recipes_select_all" ON "public"."dataset_recipes" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "dau_select_admin" ON "public"."daily_active_users" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'finance'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "delete_own_push_tokens" ON "public"."user_push_tokens" FOR DELETE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."derived_recipes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_blacklist" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_blacklist_admin" ON "public"."email_blacklist" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."email_delivery_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_logs_admin" ON "public"."email_delivery_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."embedding_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "experiment_assignments_delete_super_admin" ON "public"."experiment_assignments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "experiment_assignments_select_super_admin" ON "public"."experiment_assignments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



ALTER TABLE "public"."experiments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "experiments_select_super_admin" ON "public"."experiments" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "ext_consent_no_delete" ON "public"."external_data_consents" FOR DELETE USING (false);



CREATE POLICY "ext_consent_self_insert" ON "public"."external_data_consents" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "ext_consent_self_read" ON "public"."external_data_consents" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."external_data_consents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."failed_invite_lookups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "failed_invites_no_access" ON "public"."failed_invite_lookups" USING (false);



ALTER TABLE "public"."family_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_groups_delete_representative" ON "public"."family_groups" FOR DELETE USING (("representative_id" = "auth"."uid"()));



CREATE POLICY "family_groups_select_member" ON "public"."family_groups" FOR SELECT TO "authenticated" USING ("public"."is_active_family_member"("id"));



CREATE POLICY "family_groups_update_adult" ON "public"."family_groups" FOR UPDATE TO "authenticated" USING ("public"."is_active_family_adult"("id"));



ALTER TABLE "public"."family_invites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_invites_insert_adult" ON "public"."family_invites" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_active_family_adult"("family_id"));



CREATE POLICY "family_invites_select_adult" ON "public"."family_invites" FOR SELECT TO "authenticated" USING ("public"."is_active_family_adult"("family_id"));



CREATE POLICY "family_invites_update_adult" ON "public"."family_invites" FOR UPDATE TO "authenticated" USING ("public"."is_active_family_adult"("family_id"));



ALTER TABLE "public"."family_meal_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."family_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_members_select_self_or_family" ON "public"."family_members" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_active_family_member"("family_id")));



CREATE POLICY "family_members_update_self_or_adult" ON "public"."family_members" FOR UPDATE TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_active_family_adult"("family_id")));



ALTER TABLE "public"."family_promotion_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_promotion_requests_select_family" ON "public"."family_promotion_requests" FOR SELECT TO "authenticated" USING ("public"."is_active_family_adult"("family_id"));



ALTER TABLE "public"."feature_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "feature_flags_super_admin_all" ON "public"."feature_flags" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



ALTER TABLE "public"."feature_packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "feature_packages_mutate_super_admin" ON "public"."feature_packages" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "feature_packages_select_authenticated" ON "public"."feature_packages" FOR SELECT TO "authenticated" USING ((("status")::"text" = 'active'::"text"));



ALTER TABLE "public"."gdpr_deletion_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gdpr_insert_self" ON "public"."gdpr_deletion_requests" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "gdpr_select" ON "public"."gdpr_deletion_requests" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "gdpr_update" ON "public"."gdpr_deletion_requests" FOR UPDATE USING (((("user_id" = "auth"."uid"()) AND ("executed_at" IS NULL)) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles")))))));



ALTER TABLE "public"."health_challenges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_checkup_longitudinal_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_checkups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_goals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_streaks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_articles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "help_articles_manage" ON "public"."help_articles" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "help_articles_public" ON "public"."help_articles" FOR SELECT USING ((("status")::"text" = 'published'::"text"));



ALTER TABLE "public"."infra_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "infra_alerts_access" ON "public"."infra_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."infra_metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "infra_select_super_admin" ON "public"."infra_metrics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



ALTER TABLE "public"."ingredient_match_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inquiries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert_own_push_tokens" ON "public"."user_push_tokens" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."iroca_experiment_plan" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."iroca_measurements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."iroca_sample_summary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."legacy_family_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."legacy_family_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_usage_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "llm_usage_logs_select_own" ON "public"."llm_usage_logs" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "llm_usage_logs_select_super_admin" ON "public"."llm_usage_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



ALTER TABLE "public"."meal_ai_feedbacks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meal_image_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meal_image_jobs_insert_own" ON "public"."meal_image_jobs" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "meal_image_jobs_select_own" ON "public"."meal_image_jobs" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "meal_image_jobs_update_own" ON "public"."meal_image_jobs" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."meal_nutrition_debug_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meal_nutrition_estimates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meals_delete_owner" ON "public"."meals" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "meals_insert_owner" ON "public"."meals" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "meals_select_owner_or_family" ON "public"."meals" FOR SELECT USING ("public"."can_view_user_meals"("user_id"));



CREATE POLICY "meals_update_owner" ON "public"."meals" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."membership_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "membership_audit_select_admin" ON "public"."membership_audit" FOR SELECT USING ((("scope" = 'organization'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "membership_audit"."scope_id") AND ("user_profiles"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])))))));



CREATE POLICY "membership_audit_select_operator" ON "public"."membership_audit" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "membership_audit_select_self" ON "public"."membership_audit" FOR SELECT USING ((("actor_id" = "auth"."uid"()) OR ("target_user_id" = "auth"."uid"())));



ALTER TABLE "public"."metric_definitions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "metric_definitions_select" ON "public"."metric_definitions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."moderation_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "moderation_flags_admin_all" ON "public"."moderation_flags" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "nps_insert_self" ON "public"."nps_surveys" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "nps_select_admin" ON "public"."nps_surveys" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."nps_surveys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nutrition_feedback_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nutrition_targets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_daily_stats" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_invites_insert_admin" ON "public"."organization_invites" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));



CREATE POLICY "org_invites_select_admin" ON "public"."organization_invites" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));



CREATE POLICY "org_invites_update_admin" ON "public"."organization_invites" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));



ALTER TABLE "public"."org_license_pools" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_license_pools_select_member" ON "public"."org_license_pools" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "org_license_pools"."organization_id")))));



CREATE POLICY "org_license_pools_update_admin" ON "public"."org_license_pools" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "org_license_pools"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));



ALTER TABLE "public"."organization_challenge_participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_challenges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations_delete_owner" ON "public"."organizations" FOR DELETE USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "organizations_delete_super_admin" ON "public"."organizations" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "organizations_select_member" ON "public"."organizations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organizations"."id")))));



CREATE POLICY "organizations_update_admin" ON "public"."organizations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organizations"."id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"])))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organizations"."id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))) AND "public"."organizations_owner_id_unchanged"("id", "owner_id")));



CREATE POLICY "own row" ON "public"."notification_preferences" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."ownership_transfer_proposals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ownership_transfer_select" ON "public"."ownership_transfer_proposals" FOR SELECT USING ((("from_user_id" = "auth"."uid"()) OR ("to_user_id" = "auth"."uid"())));



ALTER TABLE "public"."pantry_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."password_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "password_history_no_direct_access" ON "public"."password_history" USING (false);



ALTER TABLE "public"."performance_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personal_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "personal_subscriptions_insert" ON "public"."personal_subscriptions" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "personal_subscriptions_no_delete" ON "public"."personal_subscriptions" FOR DELETE USING (false);



CREATE POLICY "personal_subscriptions_select" ON "public"."personal_subscriptions" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'finance'::"text", 'support'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "personal_subscriptions_update" ON "public"."personal_subscriptions" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



ALTER TABLE "public"."plan_price_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_price_history_no_delete" ON "public"."plan_price_history" FOR DELETE USING (false);



CREATE POLICY "plan_price_history_no_update" ON "public"."plan_price_history" FOR UPDATE USING (false);



CREATE POLICY "plan_price_history_select" ON "public"."plan_price_history" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text", 'finance'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."planned_meals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_collection_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_collections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_flags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."referral_rewards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referral_rewards_select" ON "public"."referral_rewards" FOR SELECT USING ((("referrer_id" = "auth"."uid"()) OR ("referred_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



ALTER TABLE "public"."revenue_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "revenue_snapshots_select" ON "public"."revenue_snapshots" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['finance'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "sales_activities_access" ON "public"."sales_lead_activities" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['sales'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."sales_lead_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_leads_access" ON "public"."sales_leads" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['sales'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



ALTER TABLE "public"."segment_definitions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "segment_definitions_select" ON "public"."segment_definitions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."segment_stats" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "segment_stats_select" ON "public"."segment_stats" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "select_own_push_tokens" ON "public"."user_push_tokens" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "service_role can manage dataset_import_runs" ON "public"."dataset_import_runs" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role can manage meal_image_jobs" ON "public"."meal_image_jobs" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role can read" ON "public"."user_push_tokens" FOR SELECT USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role can write derived_recipes" ON "public"."derived_recipes" FOR INSERT WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "sessions_revoke_self" ON "public"."user_sessions_metadata" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "sessions_self" ON "public"."user_sessions_metadata" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."shopping_list_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shopping_list_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shopping_lists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sport_presets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sport_presets_mutate_super_admin" ON "public"."sport_presets" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "sport_presets_select_all" ON "public"."sport_presets" FOR SELECT USING (true);



ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stripe_webhook_no_access_rls" ON "public"."stripe_webhook_events" USING (false);



ALTER TABLE "public"."subscription_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_plans_mutate_super_admin" ON "public"."subscription_plans" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));



CREATE POLICY "subscription_plans_select_public" ON "public"."subscription_plans" FOR SELECT USING (((("status")::"text" = ANY ((ARRAY['public'::character varying, 'private'::character varying])::"text"[])) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



ALTER TABLE "public"."support_ticket_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_daily_stats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_no_delete" ON "public"."terms_acceptances" FOR DELETE USING (false);



CREATE POLICY "terms_no_update" ON "public"."terms_acceptances" FOR UPDATE USING (false);



CREATE POLICY "terms_self_insert" ON "public"."terms_acceptances" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "terms_self_read" ON "public"."terms_acceptances" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "ticket_messages_insert" ON "public"."support_ticket_messages" FOR INSERT WITH CHECK ((("sender_id" = "auth"."uid"()) AND (((NOT "is_internal") AND (EXISTS ( SELECT 1
   FROM "public"."support_tickets" "t"
  WHERE (("t"."id" = "support_ticket_messages"."ticket_id") AND ("t"."user_id" = "auth"."uid"()))))) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))))));



CREATE POLICY "ticket_messages_select" ON "public"."support_ticket_messages" FOR SELECT USING ((((NOT "is_internal") AND (EXISTS ( SELECT 1
   FROM "public"."support_tickets" "t"
  WHERE (("t"."id" = "support_ticket_messages"."ticket_id") AND ("t"."user_id" = "auth"."uid"()))))) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "tickets_insert_staff" ON "public"."support_tickets" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "tickets_insert_user" ON "public"."support_tickets" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "tickets_select" ON "public"."support_tickets" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles"))))));



CREATE POLICY "tickets_update_support" ON "public"."support_tickets" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND (ARRAY['support'::"text", 'admin'::"text", 'super_admin'::"text"] && "user_profiles"."roles")))));



CREATE POLICY "user can delete own meal_image_jobs" ON "public"."meal_image_jobs" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user can manage own" ON "public"."user_push_tokens" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "user can read own derived_recipes" ON "public"."derived_recipes" FOR SELECT USING (("auth"."uid"() = "created_by_user_id"));



ALTER TABLE "public"."user_badges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_daily_meals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_metrics_select" ON "public"."user_metrics" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_performance_checkins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_segment_rankings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_segment_rankings_select" ON "public"."user_segment_rankings" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_sessions_metadata" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weekly_menu_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weekly_menus" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."nutrition_feedback_cache";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."shopping_list_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."weekly_menu_requests";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






























































































































































































































































































































































































































































































































































































































GRANT ALL ON TABLE "public"."family_members" TO "anon";
GRANT ALL ON TABLE "public"."family_members" TO "authenticated";
GRANT ALL ON TABLE "public"."family_members" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_child_promotion"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_child_promotion"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."family_groups" TO "anon";
GRANT ALL ON TABLE "public"."family_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."family_groups" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_org_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_org_invite"("p_token" "text") TO "authenticated";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."add_family_child"("p_family_id" "uuid", "p_display_name" "text", "p_child_profile" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_family_child"("p_family_id" "uuid", "p_display_name" "text", "p_child_profile" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_family_child"("p_family_id" "uuid", "p_display_name" "text", "p_child_profile" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_view_user_meals"("p_target_user_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."weekly_menu_requests" TO "anon";
GRANT ALL ON TABLE "public"."weekly_menu_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_menu_requests" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_menu_request"("p_worker_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_menu_request"("p_worker_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_handson_tour_sandbox_rows"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_old_logs"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_old_logs"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_logs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_handson_tour"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_handson_tour"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_handson_tour"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text") TO "service_role";



GRANT ALL ON TABLE "public"."family_invites" TO "anon";
GRANT ALL ON TABLE "public"."family_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."family_invites" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_family_invite"("p_family_id" "uuid", "p_email" "text", "p_custom_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_family_invite"("p_family_id" "uuid", "p_email" "text", "p_custom_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_family_invite"("p_family_id" "uuid", "p_email" "text", "p_custom_message" "text") TO "service_role";



GRANT ALL ON TABLE "public"."organization_invites" TO "anon";
GRANT ALL ON TABLE "public"."organization_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_invites" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum", "p_custom_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum", "p_custom_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum", "p_custom_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_org_invite"("p_organization_id" "uuid", "p_email" "text", "p_role" "public"."org_role_enum", "p_custom_message" "text") TO "service_role";



GRANT ALL ON TABLE "public"."ownership_transfer_proposals" TO "anon";
GRANT ALL ON TABLE "public"."ownership_transfer_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."ownership_transfer_proposals" TO "service_role";



REVOKE ALL ON FUNCTION "public"."decline_family_representative_transfer"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decline_family_representative_transfer"("p_proposal_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."decline_org_owner_transfer"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decline_org_owner_transfer"("p_proposal_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."decrement_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decrement_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fill_derived_recipes_magnesium_mg"() TO "anon";
GRANT ALL ON FUNCTION "public"."fill_derived_recipes_magnesium_mg"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fill_derived_recipes_magnesium_mg"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fill_planned_meals_magnesium_mg"() TO "anon";
GRANT ALL ON FUNCTION "public"."fill_planned_meals_magnesium_mg"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fill_planned_meals_magnesium_mg"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_7d_checkin_averages"("p_user_id" "uuid", "p_date" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_invite_details"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_invite_details"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_invite_details"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_invite_details"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_promotion_details"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_promotion_details"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_promotion_details"("p_token" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."guard_family_groups_privileged"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_family_groups_privileged"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_family_groups_privileged"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_family_members_privileged"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_family_members_privileged"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_family_members_privileged"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_organizations_privileged"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_organizations_privileged"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_organizations_privileged"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged_on_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged_on_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_user_profiles_privileged_on_insert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_recipe_like_count"("p_recipe_id" "text", "p_recipe_uuid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_recipe_view_count"("recipe_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_recipe_view_count"("recipe_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_recipe_view_count"("recipe_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."invoke_catalog_import"("p_function_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invoke_catalog_import"("p_function_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_active_family_adult"("p_family_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_active_family_member"("p_family_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_inactive_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_inactive_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."leave_family"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."leave_family"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."leave_family"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."leave_org"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."leave_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."leave_org"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_families_with_inactive_representative"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_families_with_inactive_representative"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_families_with_inactive_representative"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_orgs_with_inactive_owner"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_orgs_with_inactive_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_orgs_with_inactive_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_dish_name"("name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_dish_name"("name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_dish_name"("name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."organizations_owner_id_unchanged"("p_org_id" "uuid", "p_new_owner_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."paste_meal_to_family"("p_source_meal_id" "uuid", "p_target_user_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."paste_meal_to_family"("p_source_meal_id" "uuid", "p_target_user_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."paste_meal_to_family"("p_source_meal_id" "uuid", "p_target_user_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."preview_family_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_family_invite"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."preview_family_invite"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_family_invite"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."preview_org_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_org_invite"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."preview_org_invite"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_org_invite"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."promote_child_to_user"("p_member_id" "uuid", "p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promote_child_to_user"("p_member_id" "uuid", "p_email" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."propose_family_representative_transfer"("p_family_id" "uuid", "p_to_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."propose_family_representative_transfer"("p_family_id" "uuid", "p_to_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."propose_family_representative_transfer"("p_family_id" "uuid", "p_to_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."propose_org_owner_transfer"("p_organization_id" "uuid", "p_to_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."propose_org_owner_transfer"("p_organization_id" "uuid", "p_to_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."propose_org_owner_transfer"("p_organization_id" "uuid", "p_to_user_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."family_promotion_requests" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("family_id") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("member_id") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("email") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("requested_by") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("expires_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("resolved_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";



GRANT SELECT("resolved_by") ON TABLE "public"."family_promotion_requests" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reject_child_promotion"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_child_promotion"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reject_family_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_family_invite"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_family_invite"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_org_invite"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_org_invite"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_org_invite"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_user_membership"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_user_membership"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_child_promotion"("p_member_id" "uuid", "p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_child_promotion"("p_member_id" "uuid", "p_email" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reset_e2e_test_users"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_e2e_test_users"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."revoke_child_promotion"("p_member_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_child_promotion"("p_member_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."revoke_family_invite"("p_invite_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_family_invite"("p_invite_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_family_invite"("p_invite_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."revoke_org_invite"("p_invite_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revoke_org_invite"("p_invite_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_org_invite"("p_invite_id" "uuid") TO "service_role";






GRANT ALL ON FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_ingredients_by_text_similarity"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "service_role";












GRANT ALL ON FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_recipes_with_nutrition"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_similar_dataset_ingredients"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_similar_dataset_ingredients"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_similar_dataset_ingredients"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_similar_dataset_recipes"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_similar_dataset_recipes"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_similar_dataset_recipes"("query_name" "text", "similarity_threshold" numeric, "result_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_recipe_like_count"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_recipe_like_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_embedding_jobs_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_embedding_jobs_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_embedding_jobs_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_health_checkups_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_health_checkups_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_health_checkups_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_health_goals_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_health_goals_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_health_goals_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_health_records_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_health_records_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_health_records_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_health_streaks_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_health_streaks_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_health_streaks_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_my_share_settings"("p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_my_share_settings"("p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_my_share_settings"("p_share_meals" boolean, "p_share_health" boolean, "p_share_menu" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_performance_checkin_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_performance_checkin_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_performance_checkin_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_daily_meal_slot"("p_user_id" "uuid", "p_day_date" "date", "p_meal_type" "text", "p_planned_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_daily_meal_slot"("p_user_id" "uuid", "p_day_date" "date", "p_meal_type" "text", "p_planned_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."user_has_non_sandbox_activity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."user_has_non_sandbox_activity"() TO "anon";
GRANT ALL ON FUNCTION "public"."user_has_non_sandbox_activity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_has_non_sandbox_activity"() TO "service_role";




































GRANT ALL ON TABLE "public"."admin_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."admin_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."admin_user_notes" TO "anon";
GRANT ALL ON TABLE "public"."admin_user_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_user_notes" TO "service_role";



GRANT ALL ON TABLE "public"."ai_action_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_action_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_action_logs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "anon";
GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "service_role";



GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "anon";
GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_content_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_content_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_content_logs" TO "service_role";



GRANT ALL ON TABLE "public"."announcement_reads" TO "anon";
GRANT ALL ON TABLE "public"."announcement_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."announcement_reads" TO "service_role";



GRANT ALL ON TABLE "public"."announcements" TO "anon";
GRANT ALL ON TABLE "public"."announcements" TO "authenticated";
GRANT ALL ON TABLE "public"."announcements" TO "service_role";



GRANT ALL ON TABLE "public"."app_logs" TO "anon";
GRANT ALL ON TABLE "public"."app_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."app_logs" TO "service_role";



GRANT ALL ON TABLE "public"."badges" TO "anon";
GRANT ALL ON TABLE "public"."badges" TO "authenticated";
GRANT ALL ON TABLE "public"."badges" TO "service_role";



GRANT ALL ON TABLE "public"."blood_test_longitudinal_reviews" TO "anon";
GRANT ALL ON TABLE "public"."blood_test_longitudinal_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."blood_test_longitudinal_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."blood_test_results" TO "anon";
GRANT ALL ON TABLE "public"."blood_test_results" TO "authenticated";
GRANT ALL ON TABLE "public"."blood_test_results" TO "service_role";



GRANT ALL ON TABLE "public"."buddies" TO "anon";
GRANT ALL ON TABLE "public"."buddies" TO "authenticated";
GRANT ALL ON TABLE "public"."buddies" TO "service_role";



GRANT ALL ON TABLE "public"."buddy_actions" TO "anon";
GRANT ALL ON TABLE "public"."buddy_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."buddy_actions" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_import_runs" TO "anon";
GRANT ALL ON TABLE "public"."catalog_import_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_import_runs" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_product_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."catalog_product_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_product_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_products" TO "anon";
GRANT ALL ON TABLE "public"."catalog_products" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_products" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_raw_documents" TO "anon";
GRANT ALL ON TABLE "public"."catalog_raw_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_raw_documents" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_source_categories" TO "anon";
GRANT ALL ON TABLE "public"."catalog_source_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_source_categories" TO "service_role";



GRANT ALL ON TABLE "public"."catalog_sources" TO "anon";
GRANT ALL ON TABLE "public"."catalog_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."catalog_sources" TO "service_role";



GRANT ALL ON TABLE "public"."cookie_consents" TO "anon";
GRANT ALL ON TABLE "public"."cookie_consents" TO "authenticated";
GRANT ALL ON TABLE "public"."cookie_consents" TO "service_role";



GRANT ALL ON TABLE "public"."coupon_redemptions" TO "anon";
GRANT ALL ON TABLE "public"."coupon_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."coupon_redemptions" TO "service_role";



GRANT ALL ON TABLE "public"."coupons" TO "anon";
GRANT ALL ON TABLE "public"."coupons" TO "authenticated";
GRANT ALL ON TABLE "public"."coupons" TO "service_role";



GRANT ALL ON TABLE "public"."csat_feedbacks" TO "anon";
GRANT ALL ON TABLE "public"."csat_feedbacks" TO "authenticated";
GRANT ALL ON TABLE "public"."csat_feedbacks" TO "service_role";



GRANT ALL ON TABLE "public"."daily_active_users" TO "anon";
GRANT ALL ON TABLE "public"."daily_active_users" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_active_users" TO "service_role";



GRANT ALL ON TABLE "public"."daily_activity_logs" TO "anon";
GRANT ALL ON TABLE "public"."daily_activity_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_activity_logs" TO "service_role";



GRANT ALL ON TABLE "public"."dataset_import_runs" TO "anon";
GRANT ALL ON TABLE "public"."dataset_import_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."dataset_import_runs" TO "service_role";



GRANT ALL ON TABLE "public"."dataset_ingredients" TO "anon";
GRANT ALL ON TABLE "public"."dataset_ingredients" TO "authenticated";
GRANT ALL ON TABLE "public"."dataset_ingredients" TO "service_role";



GRANT ALL ON TABLE "public"."dataset_menu_sets" TO "anon";
GRANT ALL ON TABLE "public"."dataset_menu_sets" TO "authenticated";
GRANT ALL ON TABLE "public"."dataset_menu_sets" TO "service_role";



GRANT ALL ON TABLE "public"."dataset_recipes" TO "anon";
GRANT ALL ON TABLE "public"."dataset_recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."dataset_recipes" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."derived_recipes" TO "anon";
GRANT ALL ON TABLE "public"."derived_recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."derived_recipes" TO "service_role";



GRANT ALL ON TABLE "public"."email_blacklist" TO "anon";
GRANT ALL ON TABLE "public"."email_blacklist" TO "authenticated";
GRANT ALL ON TABLE "public"."email_blacklist" TO "service_role";



GRANT ALL ON TABLE "public"."email_delivery_logs" TO "anon";
GRANT ALL ON TABLE "public"."email_delivery_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."email_delivery_logs" TO "service_role";



GRANT ALL ON TABLE "public"."embedding_jobs" TO "anon";
GRANT ALL ON TABLE "public"."embedding_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."embedding_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."experiment_assignments" TO "anon";
GRANT ALL ON TABLE "public"."experiment_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."experiment_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."experiments" TO "anon";
GRANT ALL ON TABLE "public"."experiments" TO "authenticated";
GRANT ALL ON TABLE "public"."experiments" TO "service_role";



GRANT ALL ON TABLE "public"."external_data_consents" TO "anon";
GRANT ALL ON TABLE "public"."external_data_consents" TO "authenticated";
GRANT ALL ON TABLE "public"."external_data_consents" TO "service_role";



GRANT ALL ON TABLE "public"."failed_invite_lookups" TO "anon";
GRANT ALL ON TABLE "public"."failed_invite_lookups" TO "authenticated";
GRANT ALL ON TABLE "public"."failed_invite_lookups" TO "service_role";



GRANT ALL ON TABLE "public"."family_meal_logs" TO "anon";
GRANT ALL ON TABLE "public"."family_meal_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."family_meal_logs" TO "service_role";



GRANT ALL ON TABLE "public"."feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."feature_packages" TO "anon";
GRANT ALL ON TABLE "public"."feature_packages" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_packages" TO "service_role";



GRANT ALL ON TABLE "public"."gdpr_deletion_requests" TO "anon";
GRANT ALL ON TABLE "public"."gdpr_deletion_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."gdpr_deletion_requests" TO "service_role";



GRANT ALL ON TABLE "public"."health_challenges" TO "anon";
GRANT ALL ON TABLE "public"."health_challenges" TO "authenticated";
GRANT ALL ON TABLE "public"."health_challenges" TO "service_role";



GRANT ALL ON TABLE "public"."health_checkup_longitudinal_reviews" TO "anon";
GRANT ALL ON TABLE "public"."health_checkup_longitudinal_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."health_checkup_longitudinal_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."health_checkups" TO "anon";
GRANT ALL ON TABLE "public"."health_checkups" TO "authenticated";
GRANT ALL ON TABLE "public"."health_checkups" TO "service_role";



GRANT ALL ON TABLE "public"."health_goals" TO "anon";
GRANT ALL ON TABLE "public"."health_goals" TO "authenticated";
GRANT ALL ON TABLE "public"."health_goals" TO "service_role";



GRANT ALL ON TABLE "public"."health_insights" TO "anon";
GRANT ALL ON TABLE "public"."health_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."health_insights" TO "service_role";



GRANT ALL ON TABLE "public"."health_records" TO "anon";
GRANT ALL ON TABLE "public"."health_records" TO "authenticated";
GRANT ALL ON TABLE "public"."health_records" TO "service_role";



GRANT ALL ON TABLE "public"."health_streaks" TO "anon";
GRANT ALL ON TABLE "public"."health_streaks" TO "authenticated";
GRANT ALL ON TABLE "public"."health_streaks" TO "service_role";



GRANT ALL ON TABLE "public"."help_articles" TO "anon";
GRANT ALL ON TABLE "public"."help_articles" TO "authenticated";
GRANT ALL ON TABLE "public"."help_articles" TO "service_role";



GRANT ALL ON TABLE "public"."infra_alerts" TO "anon";
GRANT ALL ON TABLE "public"."infra_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."infra_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."infra_metrics" TO "anon";
GRANT ALL ON TABLE "public"."infra_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."infra_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."ingredient_match_cache" TO "anon";
GRANT ALL ON TABLE "public"."ingredient_match_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."ingredient_match_cache" TO "service_role";



GRANT ALL ON TABLE "public"."inquiries" TO "anon";
GRANT ALL ON TABLE "public"."inquiries" TO "authenticated";
GRANT ALL ON TABLE "public"."inquiries" TO "service_role";



GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "anon";
GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "authenticated";
GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "service_role";



GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."iroca_correction_model" TO "anon";
GRANT ALL ON TABLE "public"."iroca_correction_model" TO "authenticated";
GRANT ALL ON TABLE "public"."iroca_correction_model" TO "service_role";



GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."iroca_experiment_plan" TO "anon";
GRANT ALL ON TABLE "public"."iroca_experiment_plan" TO "authenticated";
GRANT ALL ON TABLE "public"."iroca_experiment_plan" TO "service_role";



GRANT ALL ON TABLE "public"."iroca_measurements" TO "anon";
GRANT ALL ON TABLE "public"."iroca_measurements" TO "authenticated";
GRANT ALL ON TABLE "public"."iroca_measurements" TO "service_role";



GRANT ALL ON SEQUENCE "public"."iroca_measurements_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."iroca_measurements_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."iroca_measurements_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."iroca_sample_summary" TO "anon";
GRANT ALL ON TABLE "public"."iroca_sample_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."iroca_sample_summary" TO "service_role";



GRANT ALL ON SEQUENCE "public"."iroca_sample_summary_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."iroca_sample_summary_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."iroca_sample_summary_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."legacy_family_groups" TO "anon";
GRANT ALL ON TABLE "public"."legacy_family_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."legacy_family_groups" TO "service_role";



GRANT ALL ON TABLE "public"."legacy_family_members" TO "anon";
GRANT ALL ON TABLE "public"."legacy_family_members" TO "authenticated";
GRANT ALL ON TABLE "public"."legacy_family_members" TO "service_role";



GRANT ALL ON TABLE "public"."llm_usage_logs" TO "anon";
GRANT ALL ON TABLE "public"."llm_usage_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."llm_usage_logs" TO "service_role";



GRANT ALL ON TABLE "public"."meal_ai_feedbacks" TO "anon";
GRANT ALL ON TABLE "public"."meal_ai_feedbacks" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_ai_feedbacks" TO "service_role";



GRANT ALL ON TABLE "public"."meal_image_jobs" TO "anon";
GRANT ALL ON TABLE "public"."meal_image_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_image_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."meal_nutrition_debug_logs" TO "anon";
GRANT ALL ON TABLE "public"."meal_nutrition_debug_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_nutrition_debug_logs" TO "service_role";



GRANT ALL ON TABLE "public"."meal_nutrition_estimates" TO "anon";
GRANT ALL ON TABLE "public"."meal_nutrition_estimates" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_nutrition_estimates" TO "service_role";



GRANT ALL ON TABLE "public"."meals" TO "anon";
GRANT ALL ON TABLE "public"."meals" TO "authenticated";
GRANT ALL ON TABLE "public"."meals" TO "service_role";



GRANT ALL ON TABLE "public"."membership_audit" TO "anon";
GRANT ALL ON TABLE "public"."membership_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."membership_audit" TO "service_role";



GRANT ALL ON TABLE "public"."metric_definitions" TO "anon";
GRANT ALL ON TABLE "public"."metric_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."metric_definitions" TO "service_role";



GRANT ALL ON TABLE "public"."moderation_flags" TO "anon";
GRANT ALL ON TABLE "public"."moderation_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."moderation_flags" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."nps_surveys" TO "anon";
GRANT ALL ON TABLE "public"."nps_surveys" TO "authenticated";
GRANT ALL ON TABLE "public"."nps_surveys" TO "service_role";



GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "anon";
GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "service_role";



GRANT ALL ON TABLE "public"."nutrition_targets" TO "anon";
GRANT ALL ON TABLE "public"."nutrition_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."nutrition_targets" TO "service_role";



GRANT ALL ON TABLE "public"."org_daily_stats" TO "anon";
GRANT ALL ON TABLE "public"."org_daily_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."org_daily_stats" TO "service_role";



GRANT ALL ON TABLE "public"."org_license_pools" TO "anon";
GRANT ALL ON TABLE "public"."org_license_pools" TO "authenticated";
GRANT ALL ON TABLE "public"."org_license_pools" TO "service_role";



GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "anon";
GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "service_role";



GRANT ALL ON TABLE "public"."organization_challenges" TO "anon";
GRANT ALL ON TABLE "public"."organization_challenges" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_challenges" TO "service_role";



GRANT ALL ON TABLE "public"."organization_reports" TO "anon";
GRANT ALL ON TABLE "public"."organization_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_reports" TO "service_role";



GRANT ALL ON TABLE "public"."pantry_items" TO "anon";
GRANT ALL ON TABLE "public"."pantry_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pantry_items" TO "service_role";



GRANT ALL ON TABLE "public"."password_history" TO "anon";
GRANT ALL ON TABLE "public"."password_history" TO "authenticated";
GRANT ALL ON TABLE "public"."password_history" TO "service_role";



GRANT ALL ON TABLE "public"."performance_plans" TO "anon";
GRANT ALL ON TABLE "public"."performance_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."performance_plans" TO "service_role";



GRANT ALL ON TABLE "public"."personal_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."personal_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."personal_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."plan_price_history" TO "anon";
GRANT ALL ON TABLE "public"."plan_price_history" TO "authenticated";
GRANT ALL ON TABLE "public"."plan_price_history" TO "service_role";



GRANT ALL ON TABLE "public"."planned_meals" TO "anon";
GRANT ALL ON TABLE "public"."planned_meals" TO "authenticated";
GRANT ALL ON TABLE "public"."planned_meals" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_collection_items" TO "anon";
GRANT ALL ON TABLE "public"."recipe_collection_items" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_collection_items" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_collections" TO "anon";
GRANT ALL ON TABLE "public"."recipe_collections" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_collections" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_comments" TO "anon";
GRANT ALL ON TABLE "public"."recipe_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_comments" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_flags" TO "anon";
GRANT ALL ON TABLE "public"."recipe_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_flags" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_likes" TO "anon";
GRANT ALL ON TABLE "public"."recipe_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_likes" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_requests" TO "anon";
GRANT ALL ON TABLE "public"."recipe_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_requests" TO "service_role";



GRANT ALL ON TABLE "public"."recipes" TO "anon";
GRANT ALL ON TABLE "public"."recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."recipes" TO "service_role";



GRANT ALL ON TABLE "public"."referral_rewards" TO "anon";
GRANT ALL ON TABLE "public"."referral_rewards" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_rewards" TO "service_role";



GRANT ALL ON TABLE "public"."revenue_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."revenue_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."revenue_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."sales_lead_activities" TO "anon";
GRANT ALL ON TABLE "public"."sales_lead_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_lead_activities" TO "service_role";



GRANT ALL ON TABLE "public"."sales_leads" TO "anon";
GRANT ALL ON TABLE "public"."sales_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_leads" TO "service_role";



GRANT ALL ON TABLE "public"."segment_definitions" TO "anon";
GRANT ALL ON TABLE "public"."segment_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."segment_definitions" TO "service_role";



GRANT ALL ON TABLE "public"."segment_stats" TO "anon";
GRANT ALL ON TABLE "public"."segment_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."segment_stats" TO "service_role";



GRANT ALL ON TABLE "public"."shopping_list_items" TO "anon";
GRANT ALL ON TABLE "public"."shopping_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."shopping_list_items" TO "service_role";



GRANT ALL ON TABLE "public"."shopping_list_requests" TO "anon";
GRANT ALL ON TABLE "public"."shopping_list_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."shopping_list_requests" TO "service_role";



GRANT ALL ON TABLE "public"."shopping_lists" TO "anon";
GRANT ALL ON TABLE "public"."shopping_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."shopping_lists" TO "service_role";



GRANT ALL ON TABLE "public"."sport_presets" TO "anon";
GRANT ALL ON TABLE "public"."sport_presets" TO "authenticated";
GRANT ALL ON TABLE "public"."sport_presets" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_plans" TO "anon";
GRANT ALL ON TABLE "public"."subscription_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_plans" TO "service_role";



GRANT ALL ON TABLE "public"."support_ticket_messages" TO "anon";
GRANT ALL ON TABLE "public"."support_ticket_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."support_ticket_messages" TO "service_role";



GRANT ALL ON TABLE "public"."support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."system_daily_stats" TO "anon";
GRANT ALL ON TABLE "public"."system_daily_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."system_daily_stats" TO "service_role";



GRANT ALL ON TABLE "public"."system_settings" TO "anon";
GRANT ALL ON TABLE "public"."system_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."system_settings" TO "service_role";



GRANT ALL ON TABLE "public"."terms_acceptances" TO "anon";
GRANT ALL ON TABLE "public"."terms_acceptances" TO "authenticated";
GRANT ALL ON TABLE "public"."terms_acceptances" TO "service_role";



GRANT ALL ON TABLE "public"."user_badges" TO "anon";
GRANT ALL ON TABLE "public"."user_badges" TO "authenticated";
GRANT ALL ON TABLE "public"."user_badges" TO "service_role";



GRANT ALL ON TABLE "public"."user_consultation_history" TO "anon";
GRANT ALL ON TABLE "public"."user_consultation_history" TO "authenticated";
GRANT ALL ON TABLE "public"."user_consultation_history" TO "service_role";



GRANT ALL ON TABLE "public"."user_daily_meals" TO "anon";
GRANT ALL ON TABLE "public"."user_daily_meals" TO "authenticated";
GRANT ALL ON TABLE "public"."user_daily_meals" TO "service_role";



GRANT ALL ON TABLE "public"."user_metrics" TO "anon";
GRANT ALL ON TABLE "public"."user_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."user_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."user_performance_checkins" TO "anon";
GRANT ALL ON TABLE "public"."user_performance_checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."user_performance_checkins" TO "service_role";



GRANT ALL ON TABLE "public"."user_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."user_segment_rankings" TO "anon";
GRANT ALL ON TABLE "public"."user_segment_rankings" TO "authenticated";
GRANT ALL ON TABLE "public"."user_segment_rankings" TO "service_role";



GRANT ALL ON TABLE "public"."user_sessions_metadata" TO "anon";
GRANT ALL ON TABLE "public"."user_sessions_metadata" TO "authenticated";
GRANT ALL ON TABLE "public"."user_sessions_metadata" TO "service_role";



GRANT ALL ON TABLE "public"."weekly_menus" TO "anon";
GRANT ALL ON TABLE "public"."weekly_menus" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_menus" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- ===== supabase/baseline/prod_function_acl.sql =====
-- public スキーマの関数の EXECUTE 権限を本番 (pg_proc.proacl) と一致させる
-- pg_dump の権限出力だけでは Supabase の既定権限 (anon 等への自動付与) が残るため。
-- 引数の型名は public 前提で書かれている (直前の prod_schema.sql が search_path を空にするため戻す)
SELECT pg_catalog.set_config('search_path', 'public, extensions', false);

REVOKE ALL ON ROUTINE public."accept_child_promotion"(p_token text, p_share_meals boolean, p_share_health boolean, p_share_menu boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."accept_child_promotion"(p_token text, p_share_meals boolean, p_share_health boolean, p_share_menu boolean) TO "authenticated";
REVOKE ALL ON ROUTINE public."accept_family_invite"(p_token text, p_share_meals boolean, p_share_health boolean, p_share_menu boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."accept_family_invite"(p_token text, p_share_meals boolean, p_share_health boolean, p_share_menu boolean) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."accept_family_invite"(p_token text, p_share_meals boolean, p_share_health boolean, p_share_menu boolean) TO "service_role";
REVOKE ALL ON ROUTINE public."accept_family_representative_transfer"(p_proposal_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."accept_family_representative_transfer"(p_proposal_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."accept_family_representative_transfer"(p_proposal_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."accept_org_invite"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."accept_org_invite"(p_token text) TO "authenticated";
REVOKE ALL ON ROUTINE public."accept_org_owner_transfer"(p_proposal_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."accept_org_owner_transfer"(p_proposal_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."accept_org_owner_transfer"(p_proposal_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."add_family_child"(p_family_id uuid, p_display_name text, p_child_profile jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."add_family_child"(p_family_id uuid, p_display_name text, p_child_profile jsonb) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."add_family_child"(p_family_id uuid, p_display_name text, p_child_profile jsonb) TO "service_role";
REVOKE ALL ON ROUTINE public."admin_set_user_roles"(p_user_id uuid, p_roles text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."admin_set_user_roles"(p_user_id uuid, p_roles text[]) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."admin_set_user_roles"(p_user_id uuid, p_roles text[]) TO "service_role";
REVOKE ALL ON ROUTINE public."can_view_user_meals"(p_target_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."can_view_user_meals"(p_target_user_id uuid) TO "anon";
GRANT EXECUTE ON ROUTINE public."can_view_user_meals"(p_target_user_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."can_view_user_meals"(p_target_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."claim_menu_request"(p_worker_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."claim_menu_request"(p_worker_id text) TO "service_role";
REVOKE ALL ON ROUTINE public."cleanup_handson_tour_sandbox_rows"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."cleanup_handson_tour_sandbox_rows"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."cleanup_handson_tour_sandbox_rows"() TO "service_role";
REVOKE ALL ON ROUTINE public."cleanup_old_logs"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."cleanup_old_logs"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."cleanup_old_logs"() TO "anon";
GRANT EXECUTE ON ROUTINE public."cleanup_old_logs"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."cleanup_old_logs"() TO "service_role";
REVOKE ALL ON ROUTINE public."complete_handson_tour"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."complete_handson_tour"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."complete_handson_tour"() TO "service_role";
REVOKE ALL ON ROUTINE public."create_family_group"(p_name text, p_plan_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."create_family_group"(p_name text, p_plan_key text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."create_family_group"(p_name text, p_plan_key text) TO "service_role";
REVOKE ALL ON ROUTINE public."create_family_invite"(p_family_id uuid, p_email text, p_custom_message text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."create_family_invite"(p_family_id uuid, p_email text, p_custom_message text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."create_family_invite"(p_family_id uuid, p_email text, p_custom_message text) TO "service_role";
REVOKE ALL ON ROUTINE public."create_org_invite"(p_organization_id uuid, p_email text, p_role org_role_enum, p_custom_message text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."create_org_invite"(p_organization_id uuid, p_email text, p_role org_role_enum, p_custom_message text) TO "anon";
GRANT EXECUTE ON ROUTINE public."create_org_invite"(p_organization_id uuid, p_email text, p_role org_role_enum, p_custom_message text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."create_org_invite"(p_organization_id uuid, p_email text, p_role org_role_enum, p_custom_message text) TO "service_role";
REVOKE ALL ON ROUTINE public."decline_family_representative_transfer"(p_proposal_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."decline_family_representative_transfer"(p_proposal_id uuid) TO "authenticated";
REVOKE ALL ON ROUTINE public."decline_org_owner_transfer"(p_proposal_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."decline_org_owner_transfer"(p_proposal_id uuid) TO "authenticated";
REVOKE ALL ON ROUTINE public."decrement_recipe_like_count"(p_recipe_id text, p_recipe_uuid uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."decrement_recipe_like_count"(p_recipe_id text, p_recipe_uuid uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."fill_derived_recipes_magnesium_mg"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."fill_derived_recipes_magnesium_mg"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."fill_derived_recipes_magnesium_mg"() TO "anon";
GRANT EXECUTE ON ROUTINE public."fill_derived_recipes_magnesium_mg"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."fill_derived_recipes_magnesium_mg"() TO "service_role";
REVOKE ALL ON ROUTINE public."fill_planned_meals_magnesium_mg"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."fill_planned_meals_magnesium_mg"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."fill_planned_meals_magnesium_mg"() TO "anon";
GRANT EXECUTE ON ROUTINE public."fill_planned_meals_magnesium_mg"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."fill_planned_meals_magnesium_mg"() TO "service_role";
REVOKE ALL ON ROUTINE public."get_7d_checkin_averages"(p_user_id uuid, p_date date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."get_7d_checkin_averages"(p_user_id uuid, p_date date) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."get_7d_checkin_averages"(p_user_id uuid, p_date date) TO "anon";
GRANT EXECUTE ON ROUTINE public."get_7d_checkin_averages"(p_user_id uuid, p_date date) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."get_7d_checkin_averages"(p_user_id uuid, p_date date) TO "service_role";
REVOKE ALL ON ROUTINE public."get_invite_details"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."get_invite_details"(p_token text) TO "anon";
GRANT EXECUTE ON ROUTINE public."get_invite_details"(p_token text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."get_invite_details"(p_token text) TO "service_role";
REVOKE ALL ON ROUTINE public."get_promotion_details"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."get_promotion_details"(p_token text) TO "anon";
GRANT EXECUTE ON ROUTINE public."get_promotion_details"(p_token text) TO "authenticated";
REVOKE ALL ON ROUTINE public."guard_family_groups_privileged"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."guard_family_groups_privileged"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."guard_family_groups_privileged"() TO "anon";
GRANT EXECUTE ON ROUTINE public."guard_family_groups_privileged"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."guard_family_groups_privileged"() TO "service_role";
REVOKE ALL ON ROUTINE public."guard_family_members_privileged"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."guard_family_members_privileged"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."guard_family_members_privileged"() TO "anon";
GRANT EXECUTE ON ROUTINE public."guard_family_members_privileged"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."guard_family_members_privileged"() TO "service_role";
REVOKE ALL ON ROUTINE public."guard_organizations_privileged"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."guard_organizations_privileged"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."guard_organizations_privileged"() TO "anon";
GRANT EXECUTE ON ROUTINE public."guard_organizations_privileged"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."guard_organizations_privileged"() TO "service_role";
REVOKE ALL ON ROUTINE public."guard_user_profiles_privileged"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged"() TO "anon";
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged"() TO "service_role";
REVOKE ALL ON ROUTINE public."guard_user_profiles_privileged_on_insert"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged_on_insert"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged_on_insert"() TO "anon";
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged_on_insert"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."guard_user_profiles_privileged_on_insert"() TO "service_role";
REVOKE ALL ON ROUTINE public."increment_recipe_like_count"(p_recipe_id text, p_recipe_uuid uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."increment_recipe_like_count"(p_recipe_id text, p_recipe_uuid uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."increment_recipe_view_count"(recipe_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."increment_recipe_view_count"(recipe_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."increment_recipe_view_count"(recipe_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."invoke_catalog_import"(p_function_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."invoke_catalog_import"(p_function_name text) TO "service_role";
REVOKE ALL ON ROUTINE public."is_active_family_adult"(p_family_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."is_active_family_adult"(p_family_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."is_active_family_adult"(p_family_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."is_active_family_member"(p_family_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."is_active_family_member"(p_family_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."is_active_family_member"(p_family_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."is_inactive_user"(p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."is_inactive_user"(p_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."leave_family"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."leave_family"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."leave_family"() TO "service_role";
REVOKE ALL ON ROUTINE public."leave_org"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."leave_org"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."leave_org"() TO "service_role";
REVOKE ALL ON ROUTINE public."list_families_with_inactive_representative"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."list_families_with_inactive_representative"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."list_families_with_inactive_representative"() TO "service_role";
REVOKE ALL ON ROUTINE public."list_orgs_with_inactive_owner"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."list_orgs_with_inactive_owner"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."list_orgs_with_inactive_owner"() TO "service_role";
REVOKE ALL ON ROUTINE public."normalize_dish_name"(name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."normalize_dish_name"(name text) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."normalize_dish_name"(name text) TO "anon";
GRANT EXECUTE ON ROUTINE public."normalize_dish_name"(name text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."normalize_dish_name"(name text) TO "service_role";
REVOKE ALL ON ROUTINE public."operator_force_dissolve_family"(p_family_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."operator_force_dissolve_family"(p_family_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."operator_force_dissolve_family"(p_family_id uuid, p_reason text) TO "service_role";
REVOKE ALL ON ROUTINE public."operator_force_dissolve_org"(p_organization_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."operator_force_dissolve_org"(p_organization_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."operator_force_dissolve_org"(p_organization_id uuid, p_reason text) TO "service_role";
REVOKE ALL ON ROUTINE public."operator_force_owner_transfer"(p_organization_id uuid, p_new_owner_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."operator_force_owner_transfer"(p_organization_id uuid, p_new_owner_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."operator_force_owner_transfer"(p_organization_id uuid, p_new_owner_id uuid, p_reason text) TO "service_role";
REVOKE ALL ON ROUTINE public."operator_force_representative_transfer"(p_family_id uuid, p_new_rep_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."operator_force_representative_transfer"(p_family_id uuid, p_new_rep_id uuid, p_reason text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."operator_force_representative_transfer"(p_family_id uuid, p_new_rep_id uuid, p_reason text) TO "service_role";
REVOKE ALL ON ROUTINE public."organizations_owner_id_unchanged"(p_org_id uuid, p_new_owner_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."organizations_owner_id_unchanged"(p_org_id uuid, p_new_owner_id uuid) TO "anon";
GRANT EXECUTE ON ROUTINE public."organizations_owner_id_unchanged"(p_org_id uuid, p_new_owner_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."organizations_owner_id_unchanged"(p_org_id uuid, p_new_owner_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."paste_meal_to_family"(p_source_meal_id uuid, p_target_user_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."paste_meal_to_family"(p_source_meal_id uuid, p_target_user_ids uuid[]) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."paste_meal_to_family"(p_source_meal_id uuid, p_target_user_ids uuid[]) TO "service_role";
REVOKE ALL ON ROUTINE public."preview_family_invite"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."preview_family_invite"(p_token text) TO "anon";
GRANT EXECUTE ON ROUTINE public."preview_family_invite"(p_token text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."preview_family_invite"(p_token text) TO "service_role";
REVOKE ALL ON ROUTINE public."preview_org_invite"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."preview_org_invite"(p_token text) TO "anon";
GRANT EXECUTE ON ROUTINE public."preview_org_invite"(p_token text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."preview_org_invite"(p_token text) TO "service_role";
REVOKE ALL ON ROUTINE public."promote_child_to_user"(p_member_id uuid, p_email text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."promote_child_to_user"(p_member_id uuid, p_email text) TO "authenticated";
REVOKE ALL ON ROUTINE public."propose_family_representative_transfer"(p_family_id uuid, p_to_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."propose_family_representative_transfer"(p_family_id uuid, p_to_user_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."propose_family_representative_transfer"(p_family_id uuid, p_to_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."propose_org_owner_transfer"(p_organization_id uuid, p_to_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."propose_org_owner_transfer"(p_organization_id uuid, p_to_user_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."propose_org_owner_transfer"(p_organization_id uuid, p_to_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."reject_child_promotion"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."reject_child_promotion"(p_token text) TO "authenticated";
REVOKE ALL ON ROUTINE public."reject_family_invite"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."reject_family_invite"(p_token text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."reject_family_invite"(p_token text) TO "service_role";
REVOKE ALL ON ROUTINE public."reject_org_invite"(p_token text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."reject_org_invite"(p_token text) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."reject_org_invite"(p_token text) TO "service_role";
REVOKE ALL ON ROUTINE public."release_user_membership"(p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."release_user_membership"(p_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."remove_family_member"(p_family_id uuid, p_member_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."remove_family_member"(p_family_id uuid, p_member_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."remove_family_member"(p_family_id uuid, p_member_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."remove_org_member"(p_organization_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."remove_org_member"(p_organization_id uuid, p_user_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."remove_org_member"(p_organization_id uuid, p_user_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."request_child_promotion"(p_member_id uuid, p_email text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."request_child_promotion"(p_member_id uuid, p_email text) TO "authenticated";
REVOKE ALL ON ROUTINE public."reset_e2e_test_users"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."reset_e2e_test_users"() TO "service_role";
REVOKE ALL ON ROUTINE public."revoke_child_promotion"(p_member_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."revoke_child_promotion"(p_member_id uuid) TO "authenticated";
REVOKE ALL ON ROUTINE public."revoke_family_invite"(p_invite_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."revoke_family_invite"(p_invite_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."revoke_family_invite"(p_invite_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."revoke_org_invite"(p_invite_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."revoke_org_invite"(p_invite_id uuid) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."revoke_org_invite"(p_invite_id uuid) TO "service_role";
REVOKE ALL ON ROUTINE public."search_dataset_ingredients_by_embedding"(query_embedding vector, match_count integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_dataset_ingredients_by_embedding"(query_embedding vector, match_count integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_dataset_ingredients_by_embedding"(query_embedding vector, match_count integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_dataset_ingredients_by_embedding"(query_embedding vector, match_count integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_dataset_ingredients_by_embedding"(query_embedding vector, match_count integer) TO "service_role";
REVOKE ALL ON ROUTINE public."search_ingredients_by_text_similarity"(query_name text, similarity_threshold numeric, result_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_ingredients_by_text_similarity"(query_name text, similarity_threshold numeric, result_limit integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_ingredients_by_text_similarity"(query_name text, similarity_threshold numeric, result_limit integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_ingredients_by_text_similarity"(query_name text, similarity_threshold numeric, result_limit integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_ingredients_by_text_similarity"(query_name text, similarity_threshold numeric, result_limit integer) TO "service_role";
REVOKE ALL ON ROUTINE public."search_ingredients_full_by_embedding"(query_embedding vector, match_count integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_ingredients_full_by_embedding"(query_embedding vector, match_count integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_ingredients_full_by_embedding"(query_embedding vector, match_count integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_ingredients_full_by_embedding"(query_embedding vector, match_count integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_ingredients_full_by_embedding"(query_embedding vector, match_count integer) TO "service_role";
REVOKE ALL ON ROUTINE public."search_menu_examples"(query_embedding vector, match_count integer, filter_meal_type_hint text, filter_max_sodium numeric, filter_theme_tags text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_menu_examples"(query_embedding vector, match_count integer, filter_meal_type_hint text, filter_max_sodium numeric, filter_theme_tags text[]) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_menu_examples"(query_embedding vector, match_count integer, filter_meal_type_hint text, filter_max_sodium numeric, filter_theme_tags text[]) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_menu_examples"(query_embedding vector, match_count integer, filter_meal_type_hint text, filter_max_sodium numeric, filter_theme_tags text[]) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_menu_examples"(query_embedding vector, match_count integer, filter_meal_type_hint text, filter_max_sodium numeric, filter_theme_tags text[]) TO "service_role";
REVOKE ALL ON ROUTINE public."search_recipes_hybrid"(query_text text, query_embedding vector, match_count integer, similarity_threshold numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_recipes_hybrid"(query_text text, query_embedding vector, match_count integer, similarity_threshold numeric) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_recipes_hybrid"(query_text text, query_embedding vector, match_count integer, similarity_threshold numeric) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_recipes_hybrid"(query_text text, query_embedding vector, match_count integer, similarity_threshold numeric) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_recipes_hybrid"(query_text text, query_embedding vector, match_count integer, similarity_threshold numeric) TO "service_role";
REVOKE ALL ON ROUTINE public."search_recipes_with_nutrition"(query_name text, similarity_threshold numeric, result_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_recipes_with_nutrition"(query_name text, similarity_threshold numeric, result_limit integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_recipes_with_nutrition"(query_name text, similarity_threshold numeric, result_limit integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_recipes_with_nutrition"(query_name text, similarity_threshold numeric, result_limit integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_recipes_with_nutrition"(query_name text, similarity_threshold numeric, result_limit integer) TO "service_role";
REVOKE ALL ON ROUTINE public."search_similar_dataset_ingredients"(query_name text, similarity_threshold numeric, result_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_ingredients"(query_name text, similarity_threshold numeric, result_limit integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_ingredients"(query_name text, similarity_threshold numeric, result_limit integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_ingredients"(query_name text, similarity_threshold numeric, result_limit integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_ingredients"(query_name text, similarity_threshold numeric, result_limit integer) TO "service_role";
REVOKE ALL ON ROUTINE public."search_similar_dataset_recipes"(query_name text, similarity_threshold numeric, result_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_recipes"(query_name text, similarity_threshold numeric, result_limit integer) TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_recipes"(query_name text, similarity_threshold numeric, result_limit integer) TO "anon";
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_recipes"(query_name text, similarity_threshold numeric, result_limit integer) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."search_similar_dataset_recipes"(query_name text, similarity_threshold numeric, result_limit integer) TO "service_role";
REVOKE ALL ON ROUTINE public."sync_recipe_like_count"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."sync_recipe_like_count"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_ai_consultation_sessions_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_ai_consultation_sessions_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_ai_consultation_sessions_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_ai_consultation_sessions_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_ai_consultation_sessions_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_embedding_jobs_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_embedding_jobs_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_embedding_jobs_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_embedding_jobs_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_embedding_jobs_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_family_groups_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_family_groups_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_family_groups_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_family_groups_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_family_groups_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_family_members_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_family_members_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_family_members_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_family_members_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_family_members_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_health_checkups_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_health_checkups_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_health_checkups_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_health_checkups_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_health_checkups_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_health_goals_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_health_goals_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_health_goals_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_health_goals_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_health_goals_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_health_records_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_health_records_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_health_records_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_health_records_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_health_records_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_health_streaks_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_health_streaks_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_health_streaks_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_health_streaks_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_health_streaks_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_inquiries_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_inquiries_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_inquiries_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_inquiries_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_inquiries_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_my_share_settings"(p_share_meals boolean, p_share_health boolean, p_share_menu boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_my_share_settings"(p_share_meals boolean, p_share_health boolean, p_share_menu boolean) TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_my_share_settings"(p_share_meals boolean, p_share_health boolean, p_share_menu boolean) TO "service_role";
REVOKE ALL ON ROUTINE public."update_nutrition_feedback_cache_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_nutrition_feedback_cache_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_nutrition_feedback_cache_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_nutrition_feedback_cache_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_nutrition_feedback_cache_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_nutrition_targets_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_nutrition_targets_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_nutrition_targets_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_nutrition_targets_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_nutrition_targets_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_performance_checkin_timestamp"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_performance_checkin_timestamp"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_performance_checkin_timestamp"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_performance_checkin_timestamp"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_performance_checkin_timestamp"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_shopping_list_requests_updated_at"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_shopping_list_requests_updated_at"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_shopping_list_requests_updated_at"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_shopping_list_requests_updated_at"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_shopping_list_requests_updated_at"() TO "service_role";
REVOKE ALL ON ROUTINE public."update_updated_at_column"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."update_updated_at_column"() TO PUBLIC;
GRANT EXECUTE ON ROUTINE public."update_updated_at_column"() TO "anon";
GRANT EXECUTE ON ROUTINE public."update_updated_at_column"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."update_updated_at_column"() TO "service_role";
REVOKE ALL ON ROUTINE public."upsert_daily_meal_slot"(p_user_id uuid, p_day_date date, p_meal_type text, p_planned_data jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."upsert_daily_meal_slot"(p_user_id uuid, p_day_date date, p_meal_type text, p_planned_data jsonb) TO "service_role";
REVOKE ALL ON ROUTINE public."user_has_non_sandbox_activity"() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON ROUTINE public."user_has_non_sandbox_activity"() TO "anon";
GRANT EXECUTE ON ROUTINE public."user_has_non_sandbox_activity"() TO "authenticated";
GRANT EXECUTE ON ROUTINE public."user_has_non_sandbox_activity"() TO "service_role";

-- ===== supabase/baseline/prod_table_acl.sql =====
-- public スキーマのテーブル / ビューの権限を本番 (pg_class.relacl) と一致させる
-- pg_dump の権限出力だけでは Supabase の既定権限 (anon 等への自動付与) が残るため。

REVOKE ALL ON TABLE public."admin_audit_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_audit_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_audit_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_audit_logs" TO "service_role";
REVOKE ALL ON TABLE public."admin_user_notes" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_user_notes" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_user_notes" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."admin_user_notes" TO "service_role";
REVOKE ALL ON TABLE public."ai_action_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_action_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_action_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_action_logs" TO "service_role";
REVOKE ALL ON TABLE public."ai_consultation_messages" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_messages" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_messages" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_messages" TO "service_role";
REVOKE ALL ON TABLE public."ai_consultation_sessions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_sessions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_sessions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_consultation_sessions" TO "service_role";
REVOKE ALL ON TABLE public."ai_content_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_content_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_content_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ai_content_logs" TO "service_role";
REVOKE ALL ON TABLE public."announcement_reads" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcement_reads" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcement_reads" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcement_reads" TO "service_role";
REVOKE ALL ON TABLE public."announcements" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcements" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcements" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcements" TO "service_role";
REVOKE ALL ON TABLE public."app_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."app_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."app_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."app_logs" TO "service_role";
REVOKE ALL ON TABLE public."badges" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."badges" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."badges" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."badges" TO "service_role";
REVOKE ALL ON TABLE public."blood_test_longitudinal_reviews" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_longitudinal_reviews" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_longitudinal_reviews" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_longitudinal_reviews" TO "service_role";
REVOKE ALL ON TABLE public."blood_test_results" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_results" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_results" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."blood_test_results" TO "service_role";
REVOKE ALL ON TABLE public."buddies" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddies" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddies" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddies" TO "service_role";
REVOKE ALL ON TABLE public."buddy_actions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddy_actions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddy_actions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."buddy_actions" TO "service_role";
REVOKE ALL ON TABLE public."catalog_import_runs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_import_runs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_import_runs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_import_runs" TO "service_role";
REVOKE ALL ON TABLE public."catalog_product_snapshots" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_product_snapshots" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_product_snapshots" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_product_snapshots" TO "service_role";
REVOKE ALL ON TABLE public."catalog_products" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_products" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_products" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_products" TO "service_role";
REVOKE ALL ON TABLE public."catalog_raw_documents" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_raw_documents" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_raw_documents" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_raw_documents" TO "service_role";
REVOKE ALL ON TABLE public."catalog_source_categories" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_source_categories" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_source_categories" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_source_categories" TO "service_role";
REVOKE ALL ON TABLE public."catalog_sources" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_sources" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_sources" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."catalog_sources" TO "service_role";
REVOKE ALL ON TABLE public."cookie_consents" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cookie_consents" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cookie_consents" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."cookie_consents" TO "service_role";
REVOKE ALL ON TABLE public."coupon_redemptions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupon_redemptions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupon_redemptions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupon_redemptions" TO "service_role";
REVOKE ALL ON TABLE public."coupons" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupons" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupons" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."coupons" TO "service_role";
REVOKE ALL ON TABLE public."csat_feedbacks" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."csat_feedbacks" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."csat_feedbacks" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."csat_feedbacks" TO "service_role";
REVOKE ALL ON TABLE public."daily_active_users" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_active_users" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_active_users" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_active_users" TO "service_role";
REVOKE ALL ON TABLE public."daily_activity_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_activity_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_activity_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."daily_activity_logs" TO "service_role";
REVOKE ALL ON TABLE public."dataset_import_runs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_import_runs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_import_runs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_import_runs" TO "service_role";
REVOKE ALL ON TABLE public."dataset_ingredients" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_ingredients" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_ingredients" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_ingredients" TO "service_role";
REVOKE ALL ON TABLE public."dataset_menu_sets" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_menu_sets" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_menu_sets" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_menu_sets" TO "service_role";
REVOKE ALL ON TABLE public."dataset_recipes" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_recipes" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_recipes" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."dataset_recipes" TO "service_role";
REVOKE ALL ON TABLE public."departments" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."departments" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."departments" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."departments" TO "service_role";
REVOKE ALL ON TABLE public."derived_recipes" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."derived_recipes" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."derived_recipes" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."derived_recipes" TO "service_role";
REVOKE ALL ON TABLE public."email_blacklist" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_blacklist" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_blacklist" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_blacklist" TO "service_role";
REVOKE ALL ON TABLE public."email_delivery_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_delivery_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_delivery_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."email_delivery_logs" TO "service_role";
REVOKE ALL ON TABLE public."embedding_jobs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."embedding_jobs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."embedding_jobs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."embedding_jobs" TO "service_role";
REVOKE ALL ON TABLE public."experiment_assignments" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiment_assignments" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiment_assignments" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiment_assignments" TO "service_role";
REVOKE ALL ON TABLE public."experiments" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiments" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiments" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."experiments" TO "service_role";
REVOKE ALL ON TABLE public."external_data_consents" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."external_data_consents" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."external_data_consents" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."external_data_consents" TO "service_role";
REVOKE ALL ON TABLE public."failed_invite_lookups" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."failed_invite_lookups" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."failed_invite_lookups" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."failed_invite_lookups" TO "service_role";
REVOKE ALL ON TABLE public."family_groups" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_groups" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_groups" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_groups" TO "service_role";
REVOKE ALL ON TABLE public."family_invites" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_invites" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_invites" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_invites" TO "service_role";
REVOKE ALL ON TABLE public."family_meal_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_meal_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_meal_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_meal_logs" TO "service_role";
REVOKE ALL ON TABLE public."family_members" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_members" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_members" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_members" TO "service_role";
REVOKE ALL ON TABLE public."family_promotion_requests" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."family_promotion_requests" TO "service_role";
REVOKE ALL ON TABLE public."feature_flags" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_flags" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_flags" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_flags" TO "service_role";
REVOKE ALL ON TABLE public."feature_packages" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_packages" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_packages" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."feature_packages" TO "service_role";
REVOKE ALL ON TABLE public."gdpr_deletion_requests" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."gdpr_deletion_requests" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."gdpr_deletion_requests" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."gdpr_deletion_requests" TO "service_role";
REVOKE ALL ON TABLE public."health_challenges" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_challenges" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_challenges" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_challenges" TO "service_role";
REVOKE ALL ON TABLE public."health_checkup_longitudinal_reviews" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkup_longitudinal_reviews" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkup_longitudinal_reviews" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkup_longitudinal_reviews" TO "service_role";
REVOKE ALL ON TABLE public."health_checkups" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkups" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkups" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_checkups" TO "service_role";
REVOKE ALL ON TABLE public."health_goals" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_goals" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_goals" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_goals" TO "service_role";
REVOKE ALL ON TABLE public."health_insights" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_insights" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_insights" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_insights" TO "service_role";
REVOKE ALL ON TABLE public."health_records" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_records" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_records" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_records" TO "service_role";
REVOKE ALL ON TABLE public."health_streaks" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_streaks" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_streaks" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."health_streaks" TO "service_role";
REVOKE ALL ON TABLE public."help_articles" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."help_articles" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."help_articles" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."help_articles" TO "service_role";
REVOKE ALL ON TABLE public."infra_alerts" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_alerts" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_alerts" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_alerts" TO "service_role";
REVOKE ALL ON TABLE public."infra_metrics" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_metrics" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_metrics" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."infra_metrics" TO "service_role";
REVOKE ALL ON TABLE public."ingredient_match_cache" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ingredient_match_cache" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ingredient_match_cache" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ingredient_match_cache" TO "service_role";
REVOKE ALL ON TABLE public."inquiries" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."inquiries" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."inquiries" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."inquiries" TO "service_role";
REVOKE ALL ON TABLE public."iroca_calibration_shots" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_calibration_shots" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_calibration_shots" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_calibration_shots" TO "service_role";
REVOKE ALL ON TABLE public."iroca_correction_model" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_correction_model" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_correction_model" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_correction_model" TO "service_role";
REVOKE ALL ON TABLE public."iroca_experiment_plan" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_experiment_plan" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_experiment_plan" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_experiment_plan" TO "service_role";
REVOKE ALL ON TABLE public."iroca_measurements" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_measurements" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_measurements" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_measurements" TO "service_role";
REVOKE ALL ON TABLE public."iroca_sample_summary" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_sample_summary" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_sample_summary" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."iroca_sample_summary" TO "service_role";
REVOKE ALL ON TABLE public."legacy_family_groups" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_groups" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_groups" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_groups" TO "service_role";
REVOKE ALL ON TABLE public."legacy_family_members" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_members" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_members" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."legacy_family_members" TO "service_role";
REVOKE ALL ON TABLE public."llm_usage_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."llm_usage_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."llm_usage_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."llm_usage_logs" TO "service_role";
REVOKE ALL ON TABLE public."meal_ai_feedbacks" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_ai_feedbacks" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_ai_feedbacks" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_ai_feedbacks" TO "service_role";
REVOKE ALL ON TABLE public."meal_image_jobs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_image_jobs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_image_jobs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_image_jobs" TO "service_role";
REVOKE ALL ON TABLE public."meal_nutrition_debug_logs" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_debug_logs" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_debug_logs" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_debug_logs" TO "service_role";
REVOKE ALL ON TABLE public."meal_nutrition_estimates" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_estimates" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_estimates" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meal_nutrition_estimates" TO "service_role";
REVOKE ALL ON TABLE public."meals" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meals" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meals" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."meals" TO "service_role";
REVOKE ALL ON TABLE public."membership_audit" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."membership_audit" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."membership_audit" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."membership_audit" TO "service_role";
REVOKE ALL ON TABLE public."metric_definitions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."metric_definitions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."metric_definitions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."metric_definitions" TO "service_role";
REVOKE ALL ON TABLE public."moderation_flags" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."moderation_flags" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."moderation_flags" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."moderation_flags" TO "service_role";
REVOKE ALL ON TABLE public."notification_preferences" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notification_preferences" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notification_preferences" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notification_preferences" TO "service_role";
REVOKE ALL ON TABLE public."nps_surveys" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nps_surveys" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nps_surveys" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nps_surveys" TO "service_role";
REVOKE ALL ON TABLE public."nutrition_feedback_cache" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_feedback_cache" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_feedback_cache" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_feedback_cache" TO "service_role";
REVOKE ALL ON TABLE public."nutrition_targets" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_targets" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_targets" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."nutrition_targets" TO "service_role";
REVOKE ALL ON TABLE public."org_daily_stats" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_daily_stats" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_daily_stats" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_daily_stats" TO "service_role";
REVOKE ALL ON TABLE public."org_license_pools" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_license_pools" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_license_pools" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."org_license_pools" TO "service_role";
REVOKE ALL ON TABLE public."organization_challenge_participants" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenge_participants" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenge_participants" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenge_participants" TO "service_role";
REVOKE ALL ON TABLE public."organization_challenges" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenges" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenges" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_challenges" TO "service_role";
REVOKE ALL ON TABLE public."organization_invites" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_invites" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_invites" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_invites" TO "service_role";
REVOKE ALL ON TABLE public."organization_reports" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_reports" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_reports" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organization_reports" TO "service_role";
REVOKE ALL ON TABLE public."organizations" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organizations" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organizations" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."organizations" TO "service_role";
REVOKE ALL ON TABLE public."ownership_transfer_proposals" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ownership_transfer_proposals" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ownership_transfer_proposals" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ownership_transfer_proposals" TO "service_role";
REVOKE ALL ON TABLE public."pantry_items" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."pantry_items" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."pantry_items" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."pantry_items" TO "service_role";
REVOKE ALL ON TABLE public."password_history" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."password_history" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."password_history" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."password_history" TO "service_role";
REVOKE ALL ON TABLE public."performance_plans" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."performance_plans" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."performance_plans" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."performance_plans" TO "service_role";
REVOKE ALL ON TABLE public."personal_subscriptions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."personal_subscriptions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."personal_subscriptions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."personal_subscriptions" TO "service_role";
REVOKE ALL ON TABLE public."plan_price_history" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."plan_price_history" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."plan_price_history" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."plan_price_history" TO "service_role";
REVOKE ALL ON TABLE public."planned_meals" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."planned_meals" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."planned_meals" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."planned_meals" TO "service_role";
REVOKE ALL ON TABLE public."recipe_collection_items" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collection_items" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collection_items" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collection_items" TO "service_role";
REVOKE ALL ON TABLE public."recipe_collections" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collections" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collections" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_collections" TO "service_role";
REVOKE ALL ON TABLE public."recipe_comments" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_comments" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_comments" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_comments" TO "service_role";
REVOKE ALL ON TABLE public."recipe_flags" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_flags" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_flags" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_flags" TO "service_role";
REVOKE ALL ON TABLE public."recipe_likes" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_likes" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_likes" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_likes" TO "service_role";
REVOKE ALL ON TABLE public."recipe_requests" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_requests" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_requests" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_requests" TO "service_role";
REVOKE ALL ON TABLE public."recipes" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipes" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipes" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipes" TO "service_role";
REVOKE ALL ON TABLE public."referral_rewards" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."referral_rewards" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."referral_rewards" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."referral_rewards" TO "service_role";
REVOKE ALL ON TABLE public."revenue_snapshots" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."revenue_snapshots" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."revenue_snapshots" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."revenue_snapshots" TO "service_role";
REVOKE ALL ON TABLE public."sales_lead_activities" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_lead_activities" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_lead_activities" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_lead_activities" TO "service_role";
REVOKE ALL ON TABLE public."sales_leads" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_leads" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_leads" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sales_leads" TO "service_role";
REVOKE ALL ON TABLE public."segment_definitions" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_definitions" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_definitions" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_definitions" TO "service_role";
REVOKE ALL ON TABLE public."segment_stats" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_stats" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_stats" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."segment_stats" TO "service_role";
REVOKE ALL ON TABLE public."shopping_list_items" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_items" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_items" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_items" TO "service_role";
REVOKE ALL ON TABLE public."shopping_list_requests" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_requests" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_requests" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_list_requests" TO "service_role";
REVOKE ALL ON TABLE public."shopping_lists" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_lists" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_lists" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."shopping_lists" TO "service_role";
REVOKE ALL ON TABLE public."sport_presets" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sport_presets" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sport_presets" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."sport_presets" TO "service_role";
REVOKE ALL ON TABLE public."stripe_webhook_events" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."stripe_webhook_events" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."stripe_webhook_events" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."stripe_webhook_events" TO "service_role";
REVOKE ALL ON TABLE public."subscription_plans" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."subscription_plans" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."subscription_plans" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."subscription_plans" TO "service_role";
REVOKE ALL ON TABLE public."support_ticket_messages" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_ticket_messages" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_ticket_messages" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_ticket_messages" TO "service_role";
REVOKE ALL ON TABLE public."support_tickets" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_tickets" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_tickets" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."support_tickets" TO "service_role";
REVOKE ALL ON TABLE public."system_daily_stats" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_daily_stats" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_daily_stats" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_daily_stats" TO "service_role";
REVOKE ALL ON TABLE public."system_settings" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_settings" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_settings" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."system_settings" TO "service_role";
REVOKE ALL ON TABLE public."terms_acceptances" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."terms_acceptances" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."terms_acceptances" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."terms_acceptances" TO "service_role";
REVOKE ALL ON TABLE public."user_badges" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_badges" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_badges" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_badges" TO "service_role";
REVOKE ALL ON TABLE public."user_consultation_history" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_consultation_history" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_consultation_history" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_consultation_history" TO "service_role";
REVOKE ALL ON TABLE public."user_daily_meals" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_daily_meals" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_daily_meals" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_daily_meals" TO "service_role";
REVOKE ALL ON TABLE public."user_metrics" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_metrics" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_metrics" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_metrics" TO "service_role";
REVOKE ALL ON TABLE public."user_performance_checkins" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_performance_checkins" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_performance_checkins" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_performance_checkins" TO "service_role";
REVOKE ALL ON TABLE public."user_profiles" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_profiles" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_profiles" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_profiles" TO "service_role";
REVOKE ALL ON TABLE public."user_push_tokens" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_push_tokens" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_push_tokens" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_push_tokens" TO "service_role";
REVOKE ALL ON TABLE public."user_segment_rankings" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_segment_rankings" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_segment_rankings" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_segment_rankings" TO "service_role";
REVOKE ALL ON TABLE public."user_sessions_metadata" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_sessions_metadata" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_sessions_metadata" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."user_sessions_metadata" TO "service_role";
REVOKE ALL ON TABLE public."weekly_menu_requests" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menu_requests" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menu_requests" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menu_requests" TO "service_role";
REVOKE ALL ON TABLE public."weekly_menus" FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menus" TO "anon";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menus" TO "authenticated";
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."weekly_menus" TO "service_role";

-- 本番の列単位 GRANT (上のテーブル単位の REVOKE で外れたものを付け直す)
GRANT SELECT("id") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("family_id") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("member_id") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("email") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("status") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("requested_by") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("expires_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("created_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("resolved_at") ON TABLE "public"."family_promotion_requests" TO "authenticated";
GRANT SELECT("resolved_by") ON TABLE "public"."family_promotion_requests" TO "authenticated";

-- ===== supabase/baseline/prod_storage.sql =====
-- storage バケット設定と storage.objects のポリシー (本番カタログから生成)
-- storage スキーマは supabase db dump の対象外のため、カタログ (pg_policies /
-- storage.buckets) から再構成している。

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('fridge-images', 'fridge-images', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('health-checkups', 'health-checkups', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('meal_photos', 'meal_photos', true, NULL, NULL) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can delete own checkup images" ON storage."objects";
CREATE POLICY "Users can delete own checkup images" ON storage."objects" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can upload own checkup images" ON storage."objects";
CREATE POLICY "Users can upload own checkup images" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can view own checkup images" ON storage."objects";
CREATE POLICY "Users can view own checkup images" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((bucket_id = 'health-checkups'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "fridge_images_insert_own_folder" ON storage."objects";
CREATE POLICY "fridge_images_insert_own_folder" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (((bucket_id = 'fridge-images'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

DROP POLICY IF EXISTS "fridge_images_select_own_folder" ON storage."objects";
CREATE POLICY "fridge_images_select_own_folder" ON storage."objects" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (((bucket_id = 'fridge-images'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));


-- ===== supabase/baseline/prod_reference_data.sql =====
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: badges; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('f2931f30-566c-4b90-ab49-e22502c73fba', 'health_streak_7', '🌱 健康記録1週間', '7日連続で健康記録を達成', '{"days": 7, "type": "health_streak"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('9a94feb7-dea9-4c87-8a53-afbeee4af31d', 'health_streak_14', '🌿 健康記録2週間', '14日連続で健康記録を達成', '{"days": 14, "type": "health_streak"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('011c8a79-6aae-486e-8abf-f3132a83ca05', 'health_streak_30', '🌳 健康記録1ヶ月', '30日連続で健康記録を達成', '{"days": 30, "type": "health_streak"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('7ecbb169-b18e-4e62-aa79-5d1ece7d4c61', 'health_streak_60', '🏆 健康記録2ヶ月', '60日連続で健康記録を達成', '{"days": 60, "type": "health_streak"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('69337a39-5802-46dd-8733-777ae7e0a7f6', 'health_streak_100', '👑 健康記録100日', '100日連続で健康記録を達成', '{"days": 100, "type": "health_streak"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('b38dac04-4e7c-4718-ab2c-003181b81f86', 'weight_goal_achieved', '🎯 目標体重達成', '設定した目標体重を達成', '{"type": "goal_achieved", "metric": "weight"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('744bde97-54ac-4e44-89c0-09b23d1b8ea2', 'first_blood_test', '🩸 初めての検査記録', '血液検査結果を初めて記録', '{"type": "first_action", "action": "blood_test"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('a19e7166-77f3-437d-a72a-9bd47625defb', 'challenge_completed', '🏅 チャレンジ達成', '週間チャレンジを初めて達成', '{"type": "first_action", "action": "challenge"}', '2025-11-27 05:59:27.850773+00', NULL, NULL, 100);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('191de578-a482-4f5d-ae1f-88b13ad0b5f1', 'segment_rank_1', 'セグメント1位', 'セグメント内で1位を獲得しました！', '{"rank": 1, "type": "segment_rank"}', '2025-11-27 07:23:26.011911+00', NULL, '🏆', 1);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('a59bc856-01ed-4c6c-933d-f6618360b986', 'segment_rank_top3', 'トップ3', 'セグメント内で3位以内に入りました！', '{"rank": 3, "type": "segment_rank"}', '2025-11-27 07:23:26.011911+00', NULL, '🥉', 3);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('3a942859-5382-41e6-8f8f-aae40b875300', 'segment_top_5', '上位5%', 'セグメント内で上位5%に入りました！', '{"type": "segment_percentile", "threshold": 95}', '2025-11-27 07:23:26.011911+00', NULL, '🥇', 10);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('ffa9efa0-feae-4047-a640-37d634a2ac6d', 'segment_top_10', '上位10%', 'セグメント内で上位10%に入りました！', '{"type": "segment_percentile", "threshold": 90}', '2025-11-27 07:23:26.011911+00', NULL, '🥈', 11);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('90a713ed-bf36-4898-b3e1-2c83de83aed1', 'segment_top_25', '上位25%', 'セグメント内で上位25%に入りました！', '{"type": "segment_percentile", "threshold": 75}', '2025-11-27 07:23:26.011911+00', NULL, '🎖️', 12);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('040ab2ba-41f6-4705-a89c-e130ccb63e7a', 'segment_above_avg', '平均超え', 'セグメント平均を超えました！', '{"type": "segment_vs_avg", "threshold": 0}', '2025-11-27 07:23:26.011911+00', NULL, '⭐', 20);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('b352acd9-c0e7-4b3e-80f1-64c161b457d2', 'segment_above_avg_20', '平均+20%', 'セグメント平均を20%以上超えました！', '{"type": "segment_vs_avg", "threshold": 20}', '2025-11-27 07:23:26.011911+00', NULL, '⭐⭐', 19);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('09bc43d4-a7d7-41fc-a915-e18a78538c4a', 'segment_above_avg_50', '平均+50%', 'セグメント平均を50%以上超えました！', '{"type": "segment_vs_avg", "threshold": 50}', '2025-11-27 07:23:26.011911+00', NULL, '🌟', 18);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('a8d00d78-7703-4a63-8871-9003e4b6c1cc', 'improved_10', '10%改善', '前期間より10%改善しました！', '{"type": "improvement", "threshold": 10}', '2025-11-27 07:23:26.011911+00', NULL, '📈', 25);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('dc7a5bf5-8890-4ec2-ac8d-2d64789ae792', 'improved_20', '20%改善', '前期間より20%改善しました！', '{"type": "improvement", "threshold": 20}', '2025-11-27 07:23:26.011911+00', NULL, '📈📈', 24);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('0ce1b995-af99-46d7-883a-c86e832e5ceb', 'improved_50', '50%改善', '前期間より50%改善しました！', '{"type": "improvement", "threshold": 50}', '2025-11-27 07:23:26.011911+00', NULL, '🚀', 23);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('1694cd7b-f808-4b58-841e-d2b08e3d5fbe', 'breakfast_champion', '朝食チャンピオン', '朝食摂取率でセグメント1位！', '{"rank": 1, "type": "segment_rank"}', '2025-11-27 07:23:26.011911+00', 'breakfast_rate', '🌅🏆', 5);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('33bd6e9d-c0d6-4ff4-b0ed-99e31742aa42', 'veggie_champion', '野菜チャンピオン', '野菜スコアでセグメント1位！', '{"rank": 1, "type": "segment_rank"}', '2025-11-27 07:23:26.011911+00', 'veg_score_avg', '🥦🏆', 5);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('0c536c1b-d5a6-40fa-92a8-8e0ad5f26575', 'streak_champion', '継続チャンピオン', '記録継続日数でセグメント1位！', '{"rank": 1, "type": "segment_rank"}', '2025-11-27 07:23:26.011911+00', 'record_streak', '🔥🏆', 5);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('1a4ff34e-8420-4939-a356-83f1f5b6eb7d', 'first_bite', 'はじめの一歩', 'はじめて食事を記録しました。新しい習慣の第一歩です！', '{"min": 1, "type": "count"}', '2025-11-24 12:42:09.607879+00', NULL, '👣', 50);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('78426d2e-5afa-4d60-8a97-de93712d39b0', 'streak_3', '三日坊主卒業', '3日連続で記録しました。三日坊主は卒業です。', '{"days": 3, "type": "streak"}', '2025-11-24 12:42:09.607879+00', NULL, '🔥', 40);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('84555c6f-5e56-47b0-b726-10203dcc55fd', 'streak_7', '週間チャンピオン', '1週間連続で記録しました。素晴らしい継続力です！', '{"days": 7, "type": "streak"}', '2025-11-24 12:42:09.607879+00', NULL, '🔥🔥', 39);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('f60e32b4-9b04-41bd-91cc-32278e41ea80', 'streak_30', '月間マスター', '1ヶ月連続で記録しました。食生活が変わってきているはずです。', '{"days": 30, "type": "streak"}', '2025-11-24 12:42:09.607879+00', NULL, '🔥🔥🔥', 38);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('9cbe9453-27c8-4a26-a0c6-889a22d5a9cc', 'photo_10', 'カメラマン', '写真を10枚撮影しました。食卓のアルバムができてきました。', '{"min": 10, "type": "count_photo"}', '2025-11-24 12:42:09.607879+00', NULL, '📸', 45);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('c20a4835-cf27-4c01-81d0-bd56bfd7341f', 'early_bird', '朝活の達人', '朝食を7回記録しました。1日のスタートダッシュは完璧です。', '{"min": 7, "type": "count_type", "meal_type": "breakfast"}', '2025-11-24 12:42:09.607879+00', NULL, '🌅', 35);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('bfbf4b41-bf11-4df1-89dc-8f5ab6332b6b', 'night_guard', '夜のガーディアン', '夜21時以降の食事を控えています。体への思いやりを感じます。', '{"days": 5, "hour": 21, "type": "time_limit"}', '2025-11-24 12:42:09.607879+00', NULL, '🌙', 35);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('d7fb3ef0-76e3-4ff3-9022-7766774fb043', 'veggie_5', '野菜好き', '野菜たっぷりの食事を5回記録しました。体が喜んでいます。', '{"min": 5, "type": "nutrient_score", "target": "veg"}', '2025-11-24 12:42:09.607879+00', NULL, '🥦', 30);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('dd5ea618-5630-4353-8d63-c7eebf03200a', 'protein_5', 'プロテインマスター', '高タンパクな食事を5回記録しました。強い体を作っています。', '{"min": 5, "type": "nutrient_val", "target": "protein"}', '2025-11-24 12:42:09.607879+00', NULL, '💪', 30);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('e9a57004-9c96-467a-be66-f6be59dcc652', 'balance_king', 'バランスの王様', 'AIスコア90点以上の食事を記録しました。完璧なバランスです！', '{"min": 90, "type": "ai_score"}', '2025-11-24 12:42:09.607879+00', NULL, '⚖️', 25);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('43c2173a-1c45-4743-a45e-96aa6eccdd9f', 'chef_soul', '料理人の魂', '手作り料理を記録しました。愛情たっぷりの食事です。', '{"type": "tag", "value": "homemade"}', '2025-11-24 12:42:09.607879+00', NULL, '👨‍🍳', 35);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('591581db-b762-4d7b-8c67-39cf3325dd95', 'rainbow', '虹色プレート', '彩り豊かな食事を記録しました。見た目も栄養も満点です。', '{"type": "tag", "value": "colorful"}', '2025-11-24 12:42:09.607879+00', NULL, '🌈', 35);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('3deaf8b7-e7b2-44cf-8937-2eaddb203a2b', 'hello_ai', 'AIとの出会い', 'AIからのアドバイスを受け取りました。', '{"min": 1, "type": "feedback_view"}', '2025-11-24 12:42:09.607879+00', NULL, '🤖', 50);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('a0ea03ae-5632-4129-9e6b-16cc4b45f224', 'planner', '計画上手', '1週間の献立を作成しました。計画的な食生活の始まりです。', '{"min": 1, "type": "menu_create"}', '2025-11-24 12:42:09.607879+00', NULL, '📋', 40);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('b055890b-fb1f-4ba4-aee0-d16554dec280', 'legend_100', '伝説の継続者', '100日連続記録。あなたは真のレジェンドです。', '{"days": 100, "type": "streak"}', '2025-11-24 12:42:09.607879+00', NULL, '👑', 10);
INSERT INTO public.badges (id, code, name, description, condition_json, created_at, metric_code, icon, priority) VALUES ('7bc933f3-4ed5-473e-af39-5a4cc3cb7626', 'tutorial_complete', '使い方マスター', 'はじめての使い方ガイド完走 — 学習の進捗を示すゲーミフィケーション(課金・特典には連動しません)', '{"type": "event", "event": "handson_tour_completed"}', '2026-05-08 05:49:14.410469+00', NULL, NULL, 100);


--
-- Data for Name: feature_packages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('4b8e9f44-9a12-4649-aeaf-840afe78f280', 'ai_analysis', 'AI 解析', NULL, '{food_recognition,ai_consultation,ai_menu_generate}', 20, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('4519f9d6-aeb1-451a-8b00-a4cb743c7b4f', 'family_management', '家族管理', NULL, '{family_groups_enabled,shared_menu,shopping_list}', 30, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('496847b8-640d-4818-998c-e1c77196a979', 'family_8members', '家族 8 名拡張', NULL, '{family_max_8_enabled}', 40, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('bc6c6aac-3e44-4a36-ac61-48663450145c', 'org_management', '組織管理', NULL, '{org_dashboard,license_management,challenge_feature}', 50, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('364a8bbc-e99e-4e3f-8a92-0ad5fe7dfc08', 'industrial_doctor', '産業医連携', NULL, '{industrial_doctor_access,ai_doctor_advice,health_report_advanced}', 60, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('2d674178-a457-4820-b7a4-033d2a7f1a8b', 'sso', 'SSO', NULL, '{sso_saml_enabled,scim_enabled}', 70, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('fb3aee58-0ed1-461a-ae8f-8cdf6d056d36', 'basic', '基本機能', NULL, '{meal_tracking,nutrition_view,health_record}', 10, 'active', '2026-05-08 06:07:02.457725+00', '2026-05-08 10:22:37.105+00');
INSERT INTO public.feature_packages (id, package_key, display_name, description, feature_flags, display_order, status, created_at, updated_at) VALUES ('8e873d39-f2eb-46b9-a901-6f5b1eb51b3a', 'test_pkg_1778236020301', 'Integration Test Package 1778236020301', 'Created by integration test', '{ai_advisor,advanced_analytics}', 99, 'active', '2026-05-08 10:27:09.406587+00', '2026-05-08 10:27:09.406587+00');


--
-- Data for Name: sport_presets; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('soccer', 'サッカー', 'Soccer', 'ball', '[{"id": "forward", "name_en": "Forward", "name_ja": "フォワード"}, {"id": "midfielder", "name_en": "Midfielder", "name_ja": "ミッドフィルダー"}, {"id": "defender", "name_en": "Defender", "name_ja": "ディフェンダー"}, {"id": "goalkeeper", "name_en": "Goalkeeper", "name_ja": "ゴールキーパー"}]', '{"heat": 0.6, "power": 0.6, "altitude": 0.3, "strength": 0.5, "endurance": 0.9, "technique": 0.7, "weightClass": 0}', '{"recovery": "シーズンオフ回復期", "training": "オフシーズン・基礎体力強化", "competition": "リーグ戦シーズン"}', false, true, '90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('basketball', 'バスケットボール', 'Basketball', 'ball', '[{"id": "point_guard", "name_en": "Point Guard", "name_ja": "ポイントガード"}, {"id": "shooting_guard", "name_en": "Shooting Guard", "name_ja": "シューティングガード"}, {"id": "small_forward", "name_en": "Small Forward", "name_ja": "スモールフォワード"}, {"id": "power_forward", "name_en": "Power Forward", "name_ja": "パワーフォワード"}, {"id": "center", "name_en": "Center", "name_ja": "センター"}]', '{"heat": 0.4, "power": 0.8, "altitude": 0, "strength": 0.6, "endurance": 0.8, "technique": 0.8, "weightClass": 0}', NULL, false, true, '48 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('volleyball', 'バレーボール', 'Volleyball', 'ball', '[{"id": "setter", "name_en": "Setter", "name_ja": "セッター"}, {"id": "outside_hitter", "name_en": "Outside Hitter", "name_ja": "アウトサイドヒッター"}, {"id": "middle_blocker", "name_en": "Middle Blocker", "name_ja": "ミドルブロッカー"}, {"id": "opposite", "name_en": "Opposite", "name_ja": "オポジット"}, {"id": "libero", "name_en": "Libero", "name_ja": "リベロ"}]', '{"heat": 0.3, "power": 0.9, "altitude": 0, "strength": 0.6, "endurance": 0.6, "technique": 0.8, "weightClass": 0}', NULL, false, true, '60-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('baseball', '野球', 'Baseball', 'ball', '[{"id": "pitcher", "name_en": "Pitcher", "name_ja": "投手"}, {"id": "catcher", "name_en": "Catcher", "name_ja": "捕手"}, {"id": "infielder", "name_en": "Infielder", "name_ja": "内野手"}, {"id": "outfielder", "name_en": "Outfielder", "name_ja": "外野手"}]', '{"heat": 0.5, "power": 0.8, "altitude": 0, "strength": 0.6, "endurance": 0.5, "technique": 0.9, "weightClass": 0}', NULL, false, true, '3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('softball', 'ソフトボール', 'Softball', 'ball', '[{"id": "pitcher", "name_en": "Pitcher", "name_ja": "投手"}, {"id": "catcher", "name_en": "Catcher", "name_ja": "捕手"}, {"id": "infielder", "name_en": "Infielder", "name_ja": "内野手"}, {"id": "outfielder", "name_en": "Outfielder", "name_ja": "外野手"}]', '{"heat": 0.5, "power": 0.7, "altitude": 0, "strength": 0.5, "endurance": 0.5, "technique": 0.8, "weightClass": 0}', NULL, false, true, '2 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('rugby', 'ラグビー', 'Rugby', 'ball', '[{"id": "forward", "name_en": "Forward", "name_ja": "フォワード"}, {"id": "back", "name_en": "Back", "name_ja": "バックス"}, {"id": "scrum_half", "name_en": "Scrum Half", "name_ja": "スクラムハーフ"}, {"id": "fly_half", "name_en": "Fly Half", "name_ja": "フライハーフ"}]', '{"heat": 0.5, "power": 0.9, "altitude": 0, "strength": 0.9, "endurance": 0.8, "technique": 0.6, "weightClass": 0.3}', NULL, false, true, '80 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('american_football', 'アメリカンフットボール', 'American Football', 'ball', '[{"id": "quarterback", "name_en": "Quarterback", "name_ja": "クォーターバック"}, {"id": "running_back", "name_en": "Running Back", "name_ja": "ランニングバック"}, {"id": "wide_receiver", "name_en": "Wide Receiver", "name_ja": "ワイドレシーバー"}, {"id": "lineman", "name_en": "Lineman", "name_ja": "ラインマン"}]', '{"heat": 0.5, "power": 0.95, "altitude": 0, "strength": 0.9, "endurance": 0.6, "technique": 0.7, "weightClass": 0.4}', NULL, false, true, '60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('handball', 'ハンドボール', 'Handball', 'ball', '[{"id": "goalkeeper", "name_en": "Goalkeeper", "name_ja": "ゴールキーパー"}, {"id": "pivot", "name_en": "Pivot", "name_ja": "ピボット"}, {"id": "wing", "name_en": "Wing", "name_ja": "ウイング"}, {"id": "back", "name_en": "Back", "name_ja": "バック"}]', '{"heat": 0.3, "power": 0.8, "altitude": 0, "strength": 0.7, "endurance": 0.8, "technique": 0.7, "weightClass": 0}', NULL, false, true, '60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('hockey', 'ホッケー', 'Field Hockey', 'ball', '[{"id": "forward", "name_en": "Forward", "name_ja": "フォワード"}, {"id": "midfielder", "name_en": "Midfielder", "name_ja": "ミッドフィルダー"}, {"id": "defender", "name_en": "Defender", "name_ja": "ディフェンダー"}, {"id": "goalkeeper", "name_en": "Goalkeeper", "name_ja": "ゴールキーパー"}]', '{"heat": 0.6, "power": 0.6, "altitude": 0, "strength": 0.5, "endurance": 0.85, "technique": 0.8, "weightClass": 0}', NULL, false, true, '70 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('ice_hockey', 'アイスホッケー', 'Ice Hockey', 'ball', '[{"id": "forward", "name_en": "Forward", "name_ja": "フォワード"}, {"id": "defenseman", "name_en": "Defenseman", "name_ja": "ディフェンスマン"}, {"id": "goaltender", "name_en": "Goaltender", "name_ja": "ゴールテンダー"}]', '{"heat": 0, "power": 0.85, "altitude": 0, "strength": 0.7, "endurance": 0.8, "technique": 0.8, "weightClass": 0}', NULL, false, true, '60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('lacrosse', 'ラクロス', 'Lacrosse', 'ball', '[{"id": "attack", "name_en": "Attack", "name_ja": "アタック"}, {"id": "midfield", "name_en": "Midfield", "name_ja": "ミッドフィールド"}, {"id": "defense", "name_en": "Defense", "name_ja": "ディフェンス"}, {"id": "goalie", "name_en": "Goalie", "name_ja": "ゴーリー"}]', '{"heat": 0.5, "power": 0.7, "altitude": 0, "strength": 0.6, "endurance": 0.85, "technique": 0.8, "weightClass": 0}', NULL, false, true, '60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('water_polo', '水球', 'Water Polo', 'ball', '[{"id": "center", "name_en": "Center", "name_ja": "センター"}, {"id": "driver", "name_en": "Driver", "name_ja": "ドライバー"}, {"id": "goalkeeper", "name_en": "Goalkeeper", "name_ja": "ゴールキーパー"}]', '{"heat": 0.2, "power": 0.7, "altitude": 0, "strength": 0.7, "endurance": 0.95, "technique": 0.7, "weightClass": 0}', NULL, false, true, '32 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('taekwondo', 'テコンドー', 'Taekwondo', 'combat', '[{"id": "kyorugi", "name_en": "Kyorugi", "name_ja": "キョルギ"}, {"id": "poomsae", "name_en": "Poomsae", "name_ja": "プムセ"}]', '{"heat": 0.4, "power": 0.85, "altitude": 0, "strength": 0.6, "endurance": 0.75, "technique": 0.9, "weightClass": 0.9}', NULL, true, false, '6 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('futsal', 'フットサル', 'Futsal', 'ball', '[{"id": "fixo", "name_en": "Fixo", "name_ja": "フィクソ"}, {"id": "ala", "name_en": "Ala", "name_ja": "アラ"}, {"id": "pivo", "name_en": "Pivo", "name_ja": "ピヴォ"}, {"id": "goleiro", "name_en": "Goleiro", "name_ja": "ゴレイロ"}]', '{"heat": 0.3, "power": 0.7, "altitude": 0, "strength": 0.5, "endurance": 0.85, "technique": 0.9, "weightClass": 0}', NULL, false, true, '40 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('beach_volleyball', 'ビーチバレー', 'Beach Volleyball', 'ball', '[{"id": "blocker", "name_en": "Blocker", "name_ja": "ブロッカー"}, {"id": "defender", "name_en": "Defender", "name_ja": "ディフェンダー"}]', '{"heat": 0.8, "power": 0.85, "altitude": 0, "strength": 0.6, "endurance": 0.8, "technique": 0.8, "weightClass": 0}', NULL, false, true, '45 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('cricket', 'クリケット', 'Cricket', 'ball', '[{"id": "batsman", "name_en": "Batsman", "name_ja": "バッツマン"}, {"id": "bowler", "name_en": "Bowler", "name_ja": "ボウラー"}, {"id": "wicketkeeper", "name_en": "Wicketkeeper", "name_ja": "ウィケットキーパー"}, {"id": "all_rounder", "name_en": "All-rounder", "name_ja": "オールラウンダー"}]', '{"heat": 0.7, "power": 0.7, "altitude": 0, "strength": 0.5, "endurance": 0.6, "technique": 0.9, "weightClass": 0}', NULL, false, true, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('golf', 'ゴルフ', 'Golf', 'ball', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.5, "power": 0.6, "altitude": 0, "strength": 0.4, "endurance": 0.4, "technique": 0.95, "weightClass": 0}', NULL, false, false, '4-5 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('bowling', 'ボウリング', 'Bowling', 'ball', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0, "power": 0.5, "altitude": 0, "strength": 0.4, "endurance": 0.3, "technique": 0.9, "weightClass": 0}', NULL, false, false, '2-3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('billiards', 'ビリヤード', 'Billiards', 'ball', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0, "power": 0.2, "altitude": 0, "strength": 0.2, "endurance": 0.2, "technique": 0.95, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('sepak_takraw', 'セパタクロー', 'Sepak Takraw', 'ball', '[{"id": "tekong", "name_en": "Tekong", "name_ja": "テコン"}, {"id": "feeder", "name_en": "Feeder", "name_ja": "フィーダー"}, {"id": "striker", "name_en": "Striker", "name_ja": "ストライカー"}]', '{"heat": 0.5, "power": 0.8, "altitude": 0, "strength": 0.5, "endurance": 0.6, "technique": 0.9, "weightClass": 0}', NULL, false, true, '45 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('kabaddi', 'カバディ', 'Kabaddi', 'ball', '[{"id": "raider", "name_en": "Raider", "name_ja": "レイダー"}, {"id": "defender", "name_en": "Defender", "name_ja": "ディフェンダー"}]', '{"heat": 0.5, "power": 0.8, "altitude": 0, "strength": 0.8, "endurance": 0.7, "technique": 0.7, "weightClass": 0.3}', NULL, false, true, '40 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('tennis', 'テニス', 'Tennis', 'racket', '[{"id": "baseline", "name_en": "Baseliner", "name_ja": "ベースライナー"}, {"id": "serve_volley", "name_en": "Serve & Volley", "name_ja": "サーブ&ボレー"}, {"id": "all_court", "name_en": "All-Court", "name_ja": "オールラウンダー"}]', '{"heat": 0.7, "power": 0.7, "altitude": 0.2, "strength": 0.5, "endurance": 0.8, "technique": 0.9, "weightClass": 0}', '{"recovery": "休養期", "training": "オフシーズン・技術向上期", "competition": "トーナメントシーズン"}', false, false, '2-5 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('badminton', 'バドミントン', 'Badminton', 'racket', '[{"id": "singles", "name_en": "Singles", "name_ja": "シングルス"}, {"id": "doubles", "name_en": "Doubles", "name_ja": "ダブルス"}]', '{"heat": 0.4, "power": 0.75, "altitude": 0, "strength": 0.5, "endurance": 0.85, "technique": 0.9, "weightClass": 0}', NULL, false, false, '45-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('table_tennis', '卓球', 'Table Tennis', 'racket', '[{"id": "attacker", "name_en": "Attacker", "name_ja": "攻撃型"}, {"id": "defender", "name_en": "Defender", "name_ja": "守備型"}, {"id": "all_round", "name_en": "All-round", "name_ja": "オールラウンド"}]', '{"heat": 0.3, "power": 0.6, "altitude": 0, "strength": 0.4, "endurance": 0.7, "technique": 0.95, "weightClass": 0}', NULL, false, false, '30-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('squash', 'スカッシュ', 'Squash', 'racket', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.7, "altitude": 0, "strength": 0.5, "endurance": 0.9, "technique": 0.85, "weightClass": 0}', NULL, false, false, '45-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('racquetball', 'ラケットボール', 'Racquetball', 'racket', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.7, "altitude": 0, "strength": 0.5, "endurance": 0.85, "technique": 0.8, "weightClass": 0}', NULL, false, false, '30-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('padel', 'パデル', 'Padel', 'racket', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.5, "power": 0.6, "altitude": 0, "strength": 0.4, "endurance": 0.75, "technique": 0.85, "weightClass": 0}', NULL, false, false, '60-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('pickleball', 'ピックルボール', 'Pickleball', 'racket', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.5, "power": 0.5, "altitude": 0, "strength": 0.3, "endurance": 0.6, "technique": 0.8, "weightClass": 0}', NULL, false, false, '30-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('soft_tennis', 'ソフトテニス', 'Soft Tennis', 'racket', '[{"id": "front", "name_en": "Front", "name_ja": "前衛"}, {"id": "back", "name_en": "Back", "name_ja": "後衛"}]', '{"heat": 0.6, "power": 0.6, "altitude": 0, "strength": 0.4, "endurance": 0.75, "technique": 0.85, "weightClass": 0}', NULL, false, false, '60-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('judo', '柔道', 'Judo', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.85, "altitude": 0, "strength": 0.9, "endurance": 0.7, "technique": 0.9, "weightClass": 1.0}', '{"cut": "減量期", "recovery": "回復期", "training": "基礎鍛錬期", "competition": "大会シーズン"}', true, false, '5-10 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('karate', '空手', 'Karate', 'combat', '[{"id": "kata", "name_en": "Kata", "name_ja": "形"}, {"id": "kumite", "name_en": "Kumite", "name_ja": "組手"}]', '{"heat": 0.4, "power": 0.85, "altitude": 0, "strength": 0.7, "endurance": 0.7, "technique": 0.95, "weightClass": 0.8}', NULL, true, false, '3-8 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('boxing', 'ボクシング', 'Boxing', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0.3, "strength": 0.8, "endurance": 0.9, "technique": 0.85, "weightClass": 1.0}', '{"cut": "減量期", "recovery": "回復期", "training": "基礎体力期", "competition": "試合準備期"}', true, false, '36 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('kickboxing', 'キックボクシング', 'Kickboxing', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0, "strength": 0.75, "endurance": 0.85, "technique": 0.85, "weightClass": 0.9}', NULL, true, false, '15-25 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('muay_thai', 'ムエタイ', 'Muay Thai', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.7, "power": 0.9, "altitude": 0, "strength": 0.8, "endurance": 0.9, "technique": 0.85, "weightClass": 0.95}', NULL, true, false, '15-25 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('mma', '総合格闘技', 'Mixed Martial Arts', 'combat', '[{"id": "striker", "name_en": "Striker", "name_ja": "ストライカー"}, {"id": "grappler", "name_en": "Grappler", "name_ja": "グラップラー"}, {"id": "wrestler", "name_en": "Wrestler", "name_ja": "レスラー"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0.3, "strength": 0.9, "endurance": 0.9, "technique": 0.85, "weightClass": 1.0}', NULL, true, false, '15-25 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('wrestling', 'レスリング', 'Wrestling', 'combat', '[{"id": "freestyle", "name_en": "Freestyle", "name_ja": "フリースタイル"}, {"id": "greco_roman", "name_en": "Greco-Roman", "name_ja": "グレコローマン"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0, "strength": 0.95, "endurance": 0.85, "technique": 0.9, "weightClass": 1.0}', NULL, true, false, '6-9 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('brazilian_jiu_jitsu', 'ブラジリアン柔術', 'Brazilian Jiu-Jitsu', 'combat', '[{"id": "gi", "name_en": "Gi", "name_ja": "道着あり"}, {"id": "no_gi", "name_en": "No-Gi", "name_ja": "道着なし"}]', '{"heat": 0.4, "power": 0.7, "altitude": 0, "strength": 0.85, "endurance": 0.8, "technique": 0.95, "weightClass": 0.9}', NULL, true, false, '5-10 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('kendo', '剣道', 'Kendo', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.5, "power": 0.75, "altitude": 0, "strength": 0.6, "endurance": 0.7, "technique": 0.95, "weightClass": 0}', NULL, false, false, '5-10 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('fencing', 'フェンシング', 'Fencing', 'combat', '[{"id": "foil", "name_en": "Foil", "name_ja": "フルーレ"}, {"id": "epee", "name_en": "Épée", "name_ja": "エペ"}, {"id": "sabre", "name_en": "Sabre", "name_ja": "サーブル"}]', '{"heat": 0.3, "power": 0.75, "altitude": 0, "strength": 0.5, "endurance": 0.7, "technique": 0.95, "weightClass": 0}', NULL, false, false, '9 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('sumo', '相撲', 'Sumo', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.95, "altitude": 0, "strength": 0.95, "endurance": 0.4, "technique": 0.85, "weightClass": 0.8}', NULL, true, false, '30 seconds', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('aikido', '合気道', 'Aikido', 'combat', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.5, "altitude": 0, "strength": 0.5, "endurance": 0.5, "technique": 0.95, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('sprinting', '短距離走', 'Sprinting', 'running', '[{"id": "100m", "name_en": "100m", "name_ja": "100m"}, {"id": "200m", "name_en": "200m", "name_ja": "200m"}, {"id": "400m", "name_en": "400m", "name_ja": "400m"}]', '{"heat": 0.6, "power": 0.95, "altitude": 0.5, "strength": 0.8, "endurance": 0.4, "technique": 0.85, "weightClass": 0}', NULL, false, false, '10-50 seconds', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('middle_distance', '中距離走', 'Middle Distance', 'running', '[{"id": "800m", "name_en": "800m", "name_ja": "800m"}, {"id": "1500m", "name_en": "1500m", "name_ja": "1500m"}]', '{"heat": 0.6, "power": 0.7, "altitude": 0.7, "strength": 0.6, "endurance": 0.85, "technique": 0.8, "weightClass": 0}', NULL, false, false, '2-4 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('long_distance', '長距離走', 'Long Distance', 'running', '[{"id": "5000m", "name_en": "5000m", "name_ja": "5000m"}, {"id": "10000m", "name_en": "10000m", "name_ja": "10000m"}]', '{"heat": 0.7, "power": 0.5, "altitude": 0.8, "strength": 0.4, "endurance": 0.95, "technique": 0.7, "weightClass": 0}', NULL, false, false, '13-30 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('marathon', 'マラソン', 'Marathon', 'running', '[{"id": "full", "name_en": "Full Marathon", "name_ja": "フルマラソン"}, {"id": "half", "name_en": "Half Marathon", "name_ja": "ハーフマラソン"}]', '{"heat": 0.8, "power": 0.3, "altitude": 0.6, "strength": 0.3, "endurance": 0.98, "technique": 0.6, "weightClass": 0}', '{"recovery": "回復期", "training": "基礎走込み期", "competition": "レースシーズン"}', false, false, '2-6 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('ultra_marathon', 'ウルトラマラソン', 'Ultra Marathon', 'running', '[{"id": "50k", "name_en": "50km", "name_ja": "50km"}, {"id": "100k", "name_en": "100km", "name_ja": "100km"}, {"id": "100_mile", "name_en": "100 Mile", "name_ja": "100マイル"}]', '{"heat": 0.7, "power": 0.2, "altitude": 0.6, "strength": 0.4, "endurance": 1.0, "technique": 0.5, "weightClass": 0}', NULL, false, false, '5-30 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('trail_running', 'トレイルランニング', 'Trail Running', 'running', '[{"id": "short", "name_en": "Short", "name_ja": "ショート"}, {"id": "middle", "name_en": "Middle", "name_ja": "ミドル"}, {"id": "ultra", "name_en": "Ultra", "name_ja": "ウルトラ"}]', '{"heat": 0.6, "power": 0.5, "altitude": 0.8, "strength": 0.6, "endurance": 0.95, "technique": 0.7, "weightClass": 0}', NULL, false, false, '1-30 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('hurdles', 'ハードル', 'Hurdles', 'running', '[{"id": "110m", "name_en": "110m Hurdles", "name_ja": "110mH"}, {"id": "400m", "name_en": "400m Hurdles", "name_ja": "400mH"}]', '{"heat": 0.5, "power": 0.9, "altitude": 0.3, "strength": 0.7, "endurance": 0.5, "technique": 0.9, "weightClass": 0}', NULL, false, false, '13-50 seconds', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('high_jump', '走高跳', 'High Jump', 'running', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.95, "altitude": 0.3, "strength": 0.7, "endurance": 0.3, "technique": 0.95, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('long_jump', '走幅跳', 'Long Jump', 'running', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.95, "altitude": 0.3, "strength": 0.8, "endurance": 0.3, "technique": 0.9, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('pole_vault', '棒高跳', 'Pole Vault', 'running', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0.3, "strength": 0.8, "endurance": 0.3, "technique": 0.95, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('shot_put', '砲丸投', 'Shot Put', 'running', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.95, "altitude": 0, "strength": 0.95, "endurance": 0.2, "technique": 0.85, "weightClass": 0.4}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('javelin', 'やり投', 'Javelin', 'running', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.9, "altitude": 0, "strength": 0.85, "endurance": 0.3, "technique": 0.9, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('competitive_swimming', '競泳', 'Competitive Swimming', 'swimming', '[{"id": "freestyle", "name_en": "Freestyle", "name_ja": "自由形"}, {"id": "backstroke", "name_en": "Backstroke", "name_ja": "背泳ぎ"}, {"id": "breaststroke", "name_en": "Breaststroke", "name_ja": "平泳ぎ"}, {"id": "butterfly", "name_en": "Butterfly", "name_ja": "バタフライ"}, {"id": "individual_medley", "name_en": "Individual Medley", "name_ja": "個人メドレー"}]', '{"heat": 0.3, "power": 0.8, "altitude": 0.4, "strength": 0.7, "endurance": 0.9, "technique": 0.9, "weightClass": 0}', NULL, false, false, '20 seconds - 15 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('open_water_swimming', 'オープンウォータースイミング', 'Open Water Swimming', 'swimming', '[{"id": "5k", "name_en": "5km", "name_ja": "5km"}, {"id": "10k", "name_en": "10km", "name_ja": "10km"}]', '{"heat": 0.5, "power": 0.6, "altitude": 0, "strength": 0.6, "endurance": 0.95, "technique": 0.8, "weightClass": 0}', NULL, false, false, '1-2 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('synchronized_swimming', 'アーティスティックスイミング', 'Artistic Swimming', 'swimming', '[{"id": "solo", "name_en": "Solo", "name_ja": "ソロ"}, {"id": "duet", "name_en": "Duet", "name_ja": "デュエット"}, {"id": "team", "name_en": "Team", "name_ja": "チーム"}]', '{"heat": 0.2, "power": 0.7, "altitude": 0, "strength": 0.7, "endurance": 0.85, "technique": 0.95, "weightClass": 0}', NULL, false, true, '3-5 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('diving', '飛込', 'Diving', 'swimming', '[{"id": "springboard", "name_en": "Springboard", "name_ja": "飛板飛込"}, {"id": "platform", "name_en": "Platform", "name_ja": "高飛込"}]', '{"heat": 0.2, "power": 0.85, "altitude": 0, "strength": 0.7, "endurance": 0.4, "technique": 0.95, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('road_cycling', 'ロードサイクリング', 'Road Cycling', 'cycling', '[{"id": "climber", "name_en": "Climber", "name_ja": "クライマー"}, {"id": "sprinter", "name_en": "Sprinter", "name_ja": "スプリンター"}, {"id": "rouleur", "name_en": "Rouleur", "name_ja": "ルーラー"}, {"id": "all_rounder", "name_en": "All-Rounder", "name_ja": "オールラウンダー"}, {"id": "time_trialist", "name_en": "Time Trialist", "name_ja": "タイムトライアリスト"}]', '{"heat": 0.7, "power": 0.8, "altitude": 0.8, "strength": 0.6, "endurance": 0.95, "technique": 0.7, "weightClass": 0}', '{"recovery": "オフシーズン", "training": "ベース期", "competition": "レースシーズン"}', false, false, '2-7 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('track_cycling', 'トラック競技', 'Track Cycling', 'cycling', '[{"id": "sprint", "name_en": "Sprint", "name_ja": "スプリント"}, {"id": "endurance", "name_en": "Endurance", "name_ja": "エンデュランス"}]', '{"heat": 0.3, "power": 0.95, "altitude": 0.4, "strength": 0.7, "endurance": 0.7, "technique": 0.85, "weightClass": 0}', NULL, false, false, '10 seconds - 1 hour', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('mountain_biking', 'マウンテンバイク', 'Mountain Biking', 'cycling', '[{"id": "xc", "name_en": "Cross-Country", "name_ja": "クロスカントリー"}, {"id": "downhill", "name_en": "Downhill", "name_ja": "ダウンヒル"}, {"id": "enduro", "name_en": "Enduro", "name_ja": "エンデューロ"}]', '{"heat": 0.6, "power": 0.8, "altitude": 0.7, "strength": 0.7, "endurance": 0.85, "technique": 0.85, "weightClass": 0}', NULL, false, false, '1.5-3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('bmx', 'BMX', 'BMX', 'cycling', '[{"id": "racing", "name_en": "Racing", "name_ja": "レーシング"}, {"id": "freestyle", "name_en": "Freestyle", "name_ja": "フリースタイル"}]', '{"heat": 0.5, "power": 0.9, "altitude": 0, "strength": 0.7, "endurance": 0.5, "technique": 0.9, "weightClass": 0}', NULL, false, false, '30 seconds - 5 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('cyclocross', 'シクロクロス', 'Cyclocross', 'cycling', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.85, "altitude": 0, "strength": 0.7, "endurance": 0.85, "technique": 0.8, "weightClass": 0}', NULL, false, false, '45-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('triathlon', 'トライアスロン', 'Triathlon', 'cycling', '[{"id": "sprint", "name_en": "Sprint", "name_ja": "スプリント"}, {"id": "olympic", "name_en": "Olympic", "name_ja": "オリンピック"}, {"id": "half_ironman", "name_en": "Half Ironman", "name_ja": "ハーフアイアンマン"}, {"id": "ironman", "name_en": "Ironman", "name_ja": "アイアンマン"}]', '{"heat": 0.8, "power": 0.6, "altitude": 0.4, "strength": 0.5, "endurance": 0.98, "technique": 0.7, "weightClass": 0}', '{"recovery": "回復期", "training": "ベース構築期", "competition": "レースシーズン"}', false, false, '1-17 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('alpine_skiing', 'アルペンスキー', 'Alpine Skiing', 'winter', '[{"id": "slalom", "name_en": "Slalom", "name_ja": "スラローム"}, {"id": "giant_slalom", "name_en": "Giant Slalom", "name_ja": "大回転"}, {"id": "super_g", "name_en": "Super-G", "name_ja": "スーパーG"}, {"id": "downhill", "name_en": "Downhill", "name_ja": "滑降"}]', '{"heat": 0, "power": 0.85, "altitude": 0.7, "strength": 0.8, "endurance": 0.6, "technique": 0.9, "weightClass": 0}', NULL, false, false, '1-3 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('cross_country_skiing', 'クロスカントリースキー', 'Cross-Country Skiing', 'winter', '[{"id": "classic", "name_en": "Classic", "name_ja": "クラシカル"}, {"id": "freestyle", "name_en": "Freestyle", "name_ja": "フリースタイル"}]', '{"heat": 0, "power": 0.7, "altitude": 0.8, "strength": 0.7, "endurance": 0.98, "technique": 0.8, "weightClass": 0}', NULL, false, false, '20 minutes - 2 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('ski_jumping', 'スキージャンプ', 'Ski Jumping', 'winter', '[{"id": "normal_hill", "name_en": "Normal Hill", "name_ja": "ノーマルヒル"}, {"id": "large_hill", "name_en": "Large Hill", "name_ja": "ラージヒル"}]', '{"heat": 0, "power": 0.85, "altitude": 0.5, "strength": 0.6, "endurance": 0.4, "technique": 0.95, "weightClass": 0.6}', NULL, true, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('snowboarding', 'スノーボード', 'Snowboarding', 'winter', '[{"id": "halfpipe", "name_en": "Halfpipe", "name_ja": "ハーフパイプ"}, {"id": "slopestyle", "name_en": "Slopestyle", "name_ja": "スロープスタイル"}, {"id": "alpine", "name_en": "Alpine", "name_ja": "アルパイン"}, {"id": "boardercross", "name_en": "Boardercross", "name_ja": "ボーダークロス"}]', '{"heat": 0, "power": 0.8, "altitude": 0.5, "strength": 0.7, "endurance": 0.6, "technique": 0.9, "weightClass": 0}', NULL, false, false, '1-5 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('figure_skating', 'フィギュアスケート', 'Figure Skating', 'winter', '[{"id": "singles", "name_en": "Singles", "name_ja": "シングル"}, {"id": "pairs", "name_en": "Pairs", "name_ja": "ペア"}, {"id": "ice_dance", "name_en": "Ice Dance", "name_ja": "アイスダンス"}]', '{"heat": 0, "power": 0.8, "altitude": 0, "strength": 0.7, "endurance": 0.7, "technique": 0.95, "weightClass": 0.3}', NULL, false, false, '2-4 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('speed_skating', 'スピードスケート', 'Speed Skating', 'winter', '[{"id": "short_track", "name_en": "Short Track", "name_ja": "ショートトラック"}, {"id": "long_track", "name_en": "Long Track", "name_ja": "ロングトラック"}]', '{"heat": 0, "power": 0.9, "altitude": 0.4, "strength": 0.75, "endurance": 0.8, "technique": 0.85, "weightClass": 0}', NULL, false, false, '30 seconds - 15 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('curling', 'カーリング', 'Curling', 'winter', '[{"id": "skip", "name_en": "Skip", "name_ja": "スキップ"}, {"id": "third", "name_en": "Third", "name_ja": "サード"}, {"id": "second", "name_en": "Second", "name_ja": "セカンド"}, {"id": "lead", "name_en": "Lead", "name_ja": "リード"}]', '{"heat": 0, "power": 0.4, "altitude": 0, "strength": 0.4, "endurance": 0.5, "technique": 0.95, "weightClass": 0}', NULL, false, true, '2-3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('weightlifting', 'ウェイトリフティング', 'Weightlifting', 'gym', '[{"id": "snatch", "name_en": "Snatch", "name_ja": "スナッチ"}, {"id": "clean_jerk", "name_en": "Clean & Jerk", "name_ja": "クリーン&ジャーク"}]', '{"heat": 0.3, "power": 0.95, "altitude": 0, "strength": 0.95, "endurance": 0.3, "technique": 0.9, "weightClass": 1.0}', '{"cut": "減量期", "recovery": "回復期", "training": "筋力強化期", "competition": "大会準備期"}', true, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('powerlifting', 'パワーリフティング', 'Powerlifting', 'gym', '[{"id": "squat", "name_en": "Squat", "name_ja": "スクワット"}, {"id": "bench", "name_en": "Bench Press", "name_ja": "ベンチプレス"}, {"id": "deadlift", "name_en": "Deadlift", "name_ja": "デッドリフト"}]', '{"heat": 0.3, "power": 0.9, "altitude": 0, "strength": 1.0, "endurance": 0.2, "technique": 0.85, "weightClass": 0.95}', NULL, true, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('bodybuilding', 'ボディビルディング', 'Bodybuilding', 'gym', '[{"id": "mens_physique", "name_en": "Men''s Physique", "name_ja": "メンズフィジーク"}, {"id": "classic_physique", "name_en": "Classic Physique", "name_ja": "クラシックフィジーク"}, {"id": "bodybuilding", "name_en": "Bodybuilding", "name_ja": "ボディビル"}, {"id": "bikini", "name_en": "Bikini", "name_ja": "ビキニ"}, {"id": "figure", "name_en": "Figure", "name_ja": "フィギュア"}]', '{"heat": 0.2, "power": 0.7, "altitude": 0, "strength": 0.85, "endurance": 0.4, "technique": 0.6, "weightClass": 0.8}', '{"recovery": "回復期", "training": "バルク期", "competition": "減量期・コンテスト準備"}', true, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('crossfit', 'クロスフィット', 'CrossFit', 'gym', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.4, "power": 0.85, "altitude": 0, "strength": 0.85, "endurance": 0.85, "technique": 0.75, "weightClass": 0}', NULL, false, false, '15-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('gymnastics', '体操競技', 'Gymnastics', 'gym', '[{"id": "artistic", "name_en": "Artistic", "name_ja": "体操"}, {"id": "rhythmic", "name_en": "Rhythmic", "name_ja": "新体操"}, {"id": "trampoline", "name_en": "Trampoline", "name_ja": "トランポリン"}]', '{"heat": 0.2, "power": 0.9, "altitude": 0, "strength": 0.9, "endurance": 0.6, "technique": 0.98, "weightClass": 0.5}', NULL, false, false, '1-5 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('calisthenics', 'カリステニクス', 'Calisthenics', 'gym', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.3, "power": 0.75, "altitude": 0, "strength": 0.8, "endurance": 0.7, "technique": 0.85, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('yoga', 'ヨガ', 'Yoga', 'gym', '[{"id": "hatha", "name_en": "Hatha", "name_ja": "ハタヨガ"}, {"id": "vinyasa", "name_en": "Vinyasa", "name_ja": "ヴィンヤサ"}, {"id": "ashtanga", "name_en": "Ashtanga", "name_ja": "アシュタンガ"}, {"id": "hot", "name_en": "Hot Yoga", "name_ja": "ホットヨガ"}]', '{"heat": 0.3, "power": 0.4, "altitude": 0, "strength": 0.5, "endurance": 0.5, "technique": 0.85, "weightClass": 0}', NULL, false, false, '60-90 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('pilates', 'ピラティス', 'Pilates', 'gym', '[{"id": "mat", "name_en": "Mat", "name_ja": "マット"}, {"id": "reformer", "name_en": "Reformer", "name_ja": "リフォーマー"}]', '{"heat": 0.2, "power": 0.4, "altitude": 0, "strength": 0.6, "endurance": 0.4, "technique": 0.8, "weightClass": 0}', NULL, false, false, '45-60 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('rock_climbing', 'ロッククライミング', 'Rock Climbing', 'outdoor', '[{"id": "sport", "name_en": "Sport Climbing", "name_ja": "スポートクライミング"}, {"id": "bouldering", "name_en": "Bouldering", "name_ja": "ボルダリング"}, {"id": "lead", "name_en": "Lead", "name_ja": "リード"}, {"id": "speed", "name_en": "Speed", "name_ja": "スピード"}]', '{"heat": 0.4, "power": 0.8, "altitude": 0.3, "strength": 0.85, "endurance": 0.7, "technique": 0.9, "weightClass": 0.4}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('mountaineering', '登山', 'Mountaineering', 'outdoor', '[{"id": "alpine", "name_en": "Alpine", "name_ja": "アルパイン"}, {"id": "expedition", "name_en": "Expedition", "name_ja": "遠征"}, {"id": "hiking", "name_en": "Hiking", "name_ja": "ハイキング"}]', '{"heat": 0.4, "power": 0.5, "altitude": 1.0, "strength": 0.7, "endurance": 0.95, "technique": 0.7, "weightClass": 0}', NULL, false, false, '1-30 days', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('surfing', 'サーフィン', 'Surfing', 'outdoor', '[{"id": "shortboard", "name_en": "Shortboard", "name_ja": "ショートボード"}, {"id": "longboard", "name_en": "Longboard", "name_ja": "ロングボード"}]', '{"heat": 0.6, "power": 0.7, "altitude": 0, "strength": 0.6, "endurance": 0.8, "technique": 0.9, "weightClass": 0}', NULL, false, false, '2-4 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('kayaking', 'カヤック', 'Kayaking', 'outdoor', '[{"id": "sprint", "name_en": "Sprint", "name_ja": "スプリント"}, {"id": "slalom", "name_en": "Slalom", "name_ja": "スラローム"}, {"id": "whitewater", "name_en": "Whitewater", "name_ja": "ホワイトウォーター"}]', '{"heat": 0.4, "power": 0.8, "altitude": 0, "strength": 0.75, "endurance": 0.85, "technique": 0.85, "weightClass": 0}', NULL, false, false, '1 minute - 3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('rowing', 'ボート競技', 'Rowing', 'outdoor', '[{"id": "single", "name_en": "Single Scull", "name_ja": "シングルスカル"}, {"id": "double", "name_en": "Double Scull", "name_ja": "ダブルスカル"}, {"id": "coxless_pair", "name_en": "Coxless Pair", "name_ja": "ペア"}, {"id": "eight", "name_en": "Eight", "name_ja": "エイト"}]', '{"heat": 0.4, "power": 0.85, "altitude": 0, "strength": 0.8, "endurance": 0.95, "technique": 0.85, "weightClass": 0.3}', NULL, false, true, '5-8 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('sailing', 'セーリング', 'Sailing', 'outdoor', '[{"id": "dinghy", "name_en": "Dinghy", "name_ja": "ディンギー"}, {"id": "keelboat", "name_en": "Keelboat", "name_ja": "キールボート"}]', '{"heat": 0.5, "power": 0.6, "altitude": 0, "strength": 0.6, "endurance": 0.7, "technique": 0.9, "weightClass": 0.3}', NULL, false, true, '1-3 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('ballroom_dance', '社交ダンス', 'Ballroom Dance', 'dance', '[{"id": "standard", "name_en": "Standard", "name_ja": "スタンダード"}, {"id": "latin", "name_en": "Latin", "name_ja": "ラテン"}]', '{"heat": 0.3, "power": 0.6, "altitude": 0, "strength": 0.5, "endurance": 0.7, "technique": 0.95, "weightClass": 0}', NULL, false, false, '2-3 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('hip_hop_dance', 'ヒップホップダンス', 'Hip Hop Dance', 'dance', '[{"id": "breaking", "name_en": "Breaking", "name_ja": "ブレイキン"}, {"id": "popping", "name_en": "Popping", "name_ja": "ポッピン"}, {"id": "locking", "name_en": "Locking", "name_ja": "ロッキン"}]', '{"heat": 0.3, "power": 0.8, "altitude": 0, "strength": 0.7, "endurance": 0.7, "technique": 0.9, "weightClass": 0}', NULL, false, false, '1-5 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('ballet', 'バレエ', 'Ballet', 'dance', '[{"id": "classical", "name_en": "Classical", "name_ja": "クラシック"}, {"id": "contemporary", "name_en": "Contemporary", "name_ja": "コンテンポラリー"}]', '{"heat": 0.2, "power": 0.7, "altitude": 0, "strength": 0.7, "endurance": 0.7, "technique": 0.98, "weightClass": 0.5}', NULL, false, false, '2-30 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('cheerleading', 'チアリーディング', 'Cheerleading', 'dance', '[{"id": "base", "name_en": "Base", "name_ja": "ベース"}, {"id": "flyer", "name_en": "Flyer", "name_ja": "フライヤー"}, {"id": "spotter", "name_en": "Spotter", "name_ja": "スポッター"}]', '{"heat": 0.3, "power": 0.8, "altitude": 0, "strength": 0.75, "endurance": 0.7, "technique": 0.9, "weightClass": 0.4}', NULL, false, true, '2-3 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('esports', 'eスポーツ', 'E-Sports', 'esports', '[{"id": "fps", "name_en": "FPS", "name_ja": "FPS"}, {"id": "moba", "name_en": "MOBA", "name_ja": "MOBA"}, {"id": "fighting", "name_en": "Fighting Games", "name_ja": "格闘ゲーム"}, {"id": "sports", "name_en": "Sports", "name_ja": "スポーツ"}, {"id": "card", "name_en": "Card Games", "name_ja": "カードゲーム"}]', '{"heat": 0.2, "power": 0.1, "altitude": 0, "strength": 0.1, "endurance": 0.5, "technique": 0.95, "weightClass": 0}', NULL, false, true, '30 minutes - 8 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('equestrian', '馬術', 'Equestrian', 'other', '[{"id": "dressage", "name_en": "Dressage", "name_ja": "馬場馬術"}, {"id": "jumping", "name_en": "Show Jumping", "name_ja": "障害飛越"}, {"id": "eventing", "name_en": "Eventing", "name_ja": "総合馬術"}]', '{"heat": 0.4, "power": 0.5, "altitude": 0, "strength": 0.6, "endurance": 0.6, "technique": 0.95, "weightClass": 0.5}', NULL, false, false, '5-15 minutes', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('archery', 'アーチェリー', 'Archery', 'other', '[{"id": "recurve", "name_en": "Recurve", "name_ja": "リカーブ"}, {"id": "compound", "name_en": "Compound", "name_ja": "コンパウンド"}]', '{"heat": 0.4, "power": 0.4, "altitude": 0, "strength": 0.5, "endurance": 0.4, "technique": 0.98, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('shooting', '射撃', 'Shooting', 'other', '[{"id": "rifle", "name_en": "Rifle", "name_ja": "ライフル"}, {"id": "pistol", "name_en": "Pistol", "name_ja": "ピストル"}, {"id": "shotgun", "name_en": "Shotgun", "name_ja": "クレー射撃"}]', '{"heat": 0.3, "power": 0.3, "altitude": 0, "strength": 0.4, "endurance": 0.3, "technique": 0.98, "weightClass": 0}', NULL, false, false, 'varies', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');
INSERT INTO public.sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration, created_at, updated_at) VALUES ('modern_pentathlon', '近代五種', 'Modern Pentathlon', 'other', '[{"id": "general", "name_en": "General", "name_ja": "一般"}]', '{"heat": 0.5, "power": 0.7, "altitude": 0, "strength": 0.6, "endurance": 0.9, "technique": 0.85, "weightClass": 0}', NULL, false, false, '5-6 hours', '2026-01-11 23:53:44.992209+00', '2026-01-11 23:53:44.992209+00');


--
-- Data for Name: subscription_plans; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('bc3bc8e9-0160-45a9-b8cc-37a073631667', 'free', 'Free', 'personal', NULL, 0, 0, 'JPY', NULL, NULL, NULL, NULL, '{}', 'public', 10, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('88a96824-4117-4d68-bca9-20be3e92ca00', 'pro', 'Pro', 'personal', NULL, 980, 9800, 'JPY', NULL, NULL, NULL, NULL, '{}', 'public', 20, NULL, 7, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('340dfe31-abb6-427b-9ec2-188bd9ba9097', 'family_basic', 'Family Basic', 'family', NULL, 1480, 14800, 'JPY', NULL, NULL, 4, NULL, '{}', 'public', 30, NULL, 7, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('1bdebeda-51bb-49fe-a45f-72e09d3a3f7e', 'family_pro', 'Family Pro', 'family', NULL, 2480, 24800, 'JPY', NULL, NULL, 8, NULL, '{}', 'public', 40, NULL, 7, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('dc78c998-59d1-4f71-9662-68cf25e4b5a8', 'family_addon', 'Family Addon', 'family', NULL, 280, NULL, 'JPY', NULL, NULL, NULL, NULL, '{}', 'private', 50, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('a848d0f3-3a02-4555-bbc1-5d8594dea7b2', 'org_starter', 'Org Starter', 'org', NULL, 580, 5800, 'JPY', NULL, NULL, 30, NULL, '{}', 'public', 60, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('3e4c433d-d99b-4412-9e56-2429592c325a', 'org_standard', 'Org Standard', 'org', NULL, 980, 9800, 'JPY', NULL, NULL, 100, NULL, '{}', 'public', 70, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('d823b977-aaad-4aee-8d38-764ef6de2d5e', 'org_pro', 'Org Pro', 'org', NULL, 1980, 19800, 'JPY', NULL, NULL, 500, NULL, '{}', 'public', 80, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('140db4ee-8cad-42cb-b0aa-b3ea8009a30e', 'org_enterprise', 'Org Enterprise', 'org', NULL, NULL, NULL, 'JPY', NULL, NULL, NULL, NULL, '{}', 'public', 90, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 06:07:02.457725+00', '2026-05-08 06:07:02.457725+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('59a34c5b-b668-4fe7-a974-9726b5913941', 'test_integration_plan_1778236006448', 'Integration Test Plan 1778236006448', 'personal', NULL, 980, 9800, 'JPY', NULL, NULL, NULL, NULL, '{}', 'draft', 0, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 10:26:52.60431+00', '2026-05-08 10:26:52.60431+00');
INSERT INTO public.subscription_plans (id, plan_key, display_name, plan_type, description, monthly_price_jpy, yearly_price_jpy, currency, stripe_product_id, stripe_price_id, max_members, max_family_seats, feature_packages, status, display_order, banner_url, trial_days, min_contract_months, auto_renew_default, ends_at, version, superseded_by_plan_id, created_at, updated_at) VALUES ('d36ef395-f369-4545-9a7a-393559aa280b', 'test_patch_plan_1778236006448', 'Updated Plan 1778236006448', 'personal', 'Updated description', 500, NULL, 'JPY', NULL, NULL, NULL, NULL, '{}', 'draft', 0, NULL, 0, 1, true, NULL, 1, NULL, '2026-05-08 10:26:55.357686+00', '2026-05-08 10:26:56.786+00');


--
-- PostgreSQL database dump complete
--



RESET ALL;
