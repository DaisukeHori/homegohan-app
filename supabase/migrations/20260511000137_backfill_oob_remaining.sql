-- backfill: 残り 37 テーブル + トリガ関数 + 既存テーブルの out-of-band index/policy 捕捉

-- 本番へは migration repair --status applied で台帳登録のみ



-- ============================================================
-- trigger functions (out-of-band 由来)
-- ============================================================


CREATE OR REPLACE FUNCTION "public"."update_ai_consultation_sessions_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_ai_consultation_sessions_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_family_groups_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_family_groups_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_family_members_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_family_members_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_inquiries_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_inquiries_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_nutrition_feedback_cache_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_nutrition_targets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_nutrition_targets_updated_at"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."update_shopping_list_requests_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "anon";

GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."update_shopping_list_requests_updated_at"() TO "service_role";

-- ============================================================
-- metric_definitions
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."metric_definitions"
    ADD CONSTRAINT "metric_definitions_code_key" UNIQUE ("code");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."metric_definitions"
    ADD CONSTRAINT "metric_definitions_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."metric_definitions" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "metric_definitions_select" ON "public"."metric_definitions";
CREATE POLICY "metric_definitions_select" ON "public"."metric_definitions" FOR SELECT USING (true);

GRANT ALL ON TABLE "public"."metric_definitions" TO "anon";

GRANT ALL ON TABLE "public"."metric_definitions" TO "authenticated";

GRANT ALL ON TABLE "public"."metric_definitions" TO "service_role";

-- ============================================================
-- segment_definitions
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."segment_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "axes" "jsonb" NOT NULL,
    "level" integer DEFAULT 1 NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_definitions"
    ADD CONSTRAINT "segment_definitions_code_key" UNIQUE ("code");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_definitions"
    ADD CONSTRAINT "segment_definitions_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."segment_definitions" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "segment_definitions_select" ON "public"."segment_definitions";
CREATE POLICY "segment_definitions_select" ON "public"."segment_definitions" FOR SELECT USING (true);

GRANT ALL ON TABLE "public"."segment_definitions" TO "anon";

GRANT ALL ON TABLE "public"."segment_definitions" TO "authenticated";

GRANT ALL ON TABLE "public"."segment_definitions" TO "service_role";

-- ============================================================
-- announcements
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Admins can manage announcements" ON "public"."announcements";
CREATE POLICY "Admins can manage announcements" ON "public"."announcements" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Public announcements are viewable by everyone" ON "public"."announcements";
CREATE POLICY "Public announcements are viewable by everyone" ON "public"."announcements" FOR SELECT USING (("is_public" = true));

ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."announcements" TO "anon";

GRANT ALL ON TABLE "public"."announcements" TO "authenticated";

GRANT ALL ON TABLE "public"."announcements" TO "service_role";

-- ============================================================
-- ai_consultation_sessions
-- ============================================================


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

COMMENT ON COLUMN "public"."ai_consultation_sessions"."summary" IS 'AIが生成したセッションの要約';

COMMENT ON COLUMN "public"."ai_consultation_sessions"."key_topics" IS 'セッションで話された主要トピック';

COMMENT ON COLUMN "public"."ai_consultation_sessions"."action_history" IS '実行されたアクションの履歴';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_consultation_sessions"
    ADD CONSTRAINT "ai_consultation_sessions_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_ai_consultation_sessions_status" ON "public"."ai_consultation_sessions" USING "btree" ("status");

CREATE INDEX IF NOT EXISTS "idx_ai_consultation_sessions_user_id" ON "public"."ai_consultation_sessions" USING "btree" ("user_id");

CREATE OR REPLACE TRIGGER "trigger_ai_consultation_sessions_updated_at" BEFORE UPDATE ON "public"."ai_consultation_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_ai_consultation_sessions_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_consultation_sessions"
    ADD CONSTRAINT "ai_consultation_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own sessions" ON "public"."ai_consultation_sessions";
CREATE POLICY "Users can manage own sessions" ON "public"."ai_consultation_sessions" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."ai_consultation_sessions" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "anon";

GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "authenticated";

GRANT ALL ON TABLE "public"."ai_consultation_sessions" TO "service_role";

-- ============================================================
-- ai_consultation_messages
-- ============================================================


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

COMMENT ON COLUMN "public"."ai_consultation_messages"."is_important" IS 'ユーザーがマークした重要なメッセージ';

COMMENT ON COLUMN "public"."ai_consultation_messages"."importance_reason" IS '重要とマークした理由';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_consultation_messages"
    ADD CONSTRAINT "ai_consultation_messages_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_ai_consultation_messages_important" ON "public"."ai_consultation_messages" USING "btree" ("session_id", "is_important") WHERE ("is_important" = true);

CREATE INDEX IF NOT EXISTS "idx_ai_consultation_messages_session_id" ON "public"."ai_consultation_messages" USING "btree" ("session_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_consultation_messages"
    ADD CONSTRAINT "ai_consultation_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_consultation_sessions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage messages in own sessions" ON "public"."ai_consultation_messages";
CREATE POLICY "Users can manage messages in own sessions" ON "public"."ai_consultation_messages" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_consultation_messages"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_consultation_messages"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"())))));

ALTER TABLE "public"."ai_consultation_messages" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "anon";

GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "authenticated";

GRANT ALL ON TABLE "public"."ai_consultation_messages" TO "service_role";

-- ============================================================
-- ai_action_logs
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_ai_action_logs_session_id" ON "public"."ai_action_logs" USING "btree" ("session_id");

CREATE INDEX IF NOT EXISTS "idx_ai_action_logs_status" ON "public"."ai_action_logs" USING "btree" ("status");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."ai_consultation_messages"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_action_logs"
    ADD CONSTRAINT "ai_action_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_consultation_sessions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage actions in own sessions" ON "public"."ai_action_logs";
CREATE POLICY "Users can manage actions in own sessions" ON "public"."ai_action_logs" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_action_logs"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."ai_consultation_sessions"
  WHERE (("ai_consultation_sessions"."id" = "ai_action_logs"."session_id") AND ("ai_consultation_sessions"."user_id" = "auth"."uid"())))));

ALTER TABLE "public"."ai_action_logs" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."ai_action_logs" TO "anon";

GRANT ALL ON TABLE "public"."ai_action_logs" TO "authenticated";

GRANT ALL ON TABLE "public"."ai_action_logs" TO "service_role";

-- ============================================================
-- ai_content_logs
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_content_logs"
    ADD CONSTRAINT "ai_content_logs_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_ai_content_logs_created_at" ON "public"."ai_content_logs" USING "btree" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_ai_content_logs_user_id" ON "public"."ai_content_logs" USING "btree" ("user_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."ai_content_logs"
    ADD CONSTRAINT "ai_content_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "System can insert ai logs" ON "public"."ai_content_logs";
CREATE POLICY "System can insert ai logs" ON "public"."ai_content_logs" FOR INSERT TO "authenticated" WITH CHECK (true);

DROP POLICY IF EXISTS "Users and admins can view ai logs" ON "public"."ai_content_logs";
CREATE POLICY "Users and admins can view ai logs" ON "public"."ai_content_logs" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));

ALTER TABLE "public"."ai_content_logs" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."ai_content_logs" TO "anon";

GRANT ALL ON TABLE "public"."ai_content_logs" TO "authenticated";

GRANT ALL ON TABLE "public"."ai_content_logs" TO "service_role";

-- ============================================================
-- recipe_collections
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."recipe_collections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "is_public" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "recipe_ids" "uuid"[] DEFAULT '{}'::"uuid"[]
);

COMMENT ON COLUMN "public"."recipe_collections"."recipe_ids" IS 'コレクションに含まれるレシピIDの配列';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_collections"
    ADD CONSTRAINT "recipe_collections_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_recipe_collections_user_id" ON "public"."recipe_collections" USING "btree" ("user_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_collections"
    ADD CONSTRAINT "recipe_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Anyone can view public collections" ON "public"."recipe_collections";
CREATE POLICY "Anyone can view public collections" ON "public"."recipe_collections" FOR SELECT TO "authenticated" USING ((("is_public" = true) OR ("user_id" = "auth"."uid"())));

DROP POLICY IF EXISTS "Users can manage own collections" ON "public"."recipe_collections";
CREATE POLICY "Users can manage own collections" ON "public"."recipe_collections" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."recipe_collections" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."recipe_collections" TO "anon";

GRANT ALL ON TABLE "public"."recipe_collections" TO "authenticated";

GRANT ALL ON TABLE "public"."recipe_collections" TO "service_role";

-- ============================================================
-- departments
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "manager_id" "uuid",
    "display_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_departments_organization_id" ON "public"."departments" USING "btree" ("organization_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Org admins can manage departments" ON "public"."departments";
CREATE POLICY "Org admins can manage departments" ON "public"."departments" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "departments"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org members can view departments" ON "public"."departments";
CREATE POLICY "Org members can view departments" ON "public"."departments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "departments"."organization_id")))));

ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."departments" TO "anon";

GRANT ALL ON TABLE "public"."departments" TO "authenticated";

GRANT ALL ON TABLE "public"."departments" TO "service_role";

-- ============================================================
-- organization_challenges
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_organization_challenges_organization_id" ON "public"."organization_challenges" USING "btree" ("organization_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenges"
    ADD CONSTRAINT "organization_challenges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Org admins can manage challenges" ON "public"."organization_challenges";
CREATE POLICY "Org admins can manage challenges" ON "public"."organization_challenges" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_challenges"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org members can view challenges" ON "public"."organization_challenges";
CREATE POLICY "Org members can view challenges" ON "public"."organization_challenges" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_challenges"."organization_id")))));

ALTER TABLE "public"."organization_challenges" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."organization_challenges" TO "anon";

GRANT ALL ON TABLE "public"."organization_challenges" TO "authenticated";

GRANT ALL ON TABLE "public"."organization_challenges" TO "service_role";

-- ============================================================
-- organization_challenge_participants
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."organization_challenge_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "challenge_id" "uuid",
    "user_id" "uuid",
    "current_value" numeric DEFAULT 0,
    "rank" integer,
    "joined_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_challenge_id_user_id_key" UNIQUE ("challenge_id", "user_id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_organization_challenge_participants_challenge_id" ON "public"."organization_challenge_participants" USING "btree" ("challenge_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "public"."organization_challenges"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_challenge_participants"
    ADD CONSTRAINT "organization_challenge_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Org members can view participants" ON "public"."organization_challenge_participants";
CREATE POLICY "Org members can view participants" ON "public"."organization_challenge_participants" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."organization_challenges" "oc"
     JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "oc"."organization_id")))
  WHERE (("oc"."id" = "organization_challenge_participants"."challenge_id") AND ("up"."id" = "auth"."uid"())))));

DROP POLICY IF EXISTS "Users can join challenges" ON "public"."organization_challenge_participants";
CREATE POLICY "Users can join challenges" ON "public"."organization_challenge_participants" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can update own participation" ON "public"."organization_challenge_participants";
CREATE POLICY "Users can update own participation" ON "public"."organization_challenge_participants" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."organization_challenge_participants" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "anon";

GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "authenticated";

GRANT ALL ON TABLE "public"."organization_challenge_participants" TO "service_role";

-- ============================================================
-- announcement_reads
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."announcement_reads" (
    "user_id" "uuid" NOT NULL,
    "announcement_id" "uuid" NOT NULL,
    "read_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("user_id", "announcement_id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_announcement_reads_user_id" ON "public"."announcement_reads" USING "btree" ("user_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."announcement_reads"
    ADD CONSTRAINT "announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own announcement reads" ON "public"."announcement_reads";
CREATE POLICY "Users can manage own announcement reads" ON "public"."announcement_reads" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."announcement_reads" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."announcement_reads" TO "anon";

GRANT ALL ON TABLE "public"."announcement_reads" TO "authenticated";

GRANT ALL ON TABLE "public"."announcement_reads" TO "service_role";

-- ============================================================
-- admin_user_notes
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."admin_user_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "admin_id" "uuid",
    "note" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_admin_user_notes_user_id" ON "public"."admin_user_notes" USING "btree" ("user_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."admin_user_notes"
    ADD CONSTRAINT "admin_user_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Admins can manage user notes" ON "public"."admin_user_notes";
CREATE POLICY "Admins can manage user notes" ON "public"."admin_user_notes" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));

ALTER TABLE "public"."admin_user_notes" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."admin_user_notes" TO "anon";

GRANT ALL ON TABLE "public"."admin_user_notes" TO "authenticated";

GRANT ALL ON TABLE "public"."admin_user_notes" TO "service_role";

-- ============================================================
-- buddies
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."buddies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id_1" "uuid",
    "user_id_2" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_1_user_id_2_key" UNIQUE ("user_id_1", "user_id_2");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_1_fkey" FOREIGN KEY ("user_id_1") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddies"
    ADD CONSTRAINT "buddies_user_id_2_fkey" FOREIGN KEY ("user_id_2") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can view own buddies" ON "public"."buddies";
CREATE POLICY "Users can view own buddies" ON "public"."buddies" FOR SELECT USING ((("auth"."uid"() = "user_id_1") OR ("auth"."uid"() = "user_id_2")));

ALTER TABLE "public"."buddies" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."buddies" TO "anon";

GRANT ALL ON TABLE "public"."buddies" TO "authenticated";

GRANT ALL ON TABLE "public"."buddies" TO "service_role";

-- ============================================================
-- buddy_actions
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."buddy_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_user_id" "uuid",
    "to_user_id" "uuid",
    "action_type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."buddy_actions"
    ADD CONSTRAINT "buddy_actions_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own actions" ON "public"."buddy_actions";
CREATE POLICY "Users can manage own actions" ON "public"."buddy_actions" USING (("auth"."uid"() = "from_user_id"));

ALTER TABLE "public"."buddy_actions" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."buddy_actions" TO "anon";

GRANT ALL ON TABLE "public"."buddy_actions" TO "authenticated";

GRANT ALL ON TABLE "public"."buddy_actions" TO "service_role";

-- ============================================================
-- daily_activity_logs
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."daily_activity_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "date" "date" NOT NULL,
    "steps" integer,
    "calories_burned" integer,
    "feeling" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_user_id_date_key" UNIQUE ("user_id", "date");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."daily_activity_logs"
    ADD CONSTRAINT "daily_activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own activity" ON "public"."daily_activity_logs";
CREATE POLICY "Users can manage own activity" ON "public"."daily_activity_logs" USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."daily_activity_logs" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."daily_activity_logs" TO "anon";

GRANT ALL ON TABLE "public"."daily_activity_logs" TO "authenticated";

GRANT ALL ON TABLE "public"."daily_activity_logs" TO "service_role";

-- ============================================================
-- health_challenges
-- ============================================================


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

COMMENT ON TABLE "public"."health_challenges" IS '週間・月間チャレンジ（ゲーミフィケーション）';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."health_challenges"
    ADD CONSTRAINT "health_challenges_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_health_challenges_active" ON "public"."health_challenges" USING "btree" ("user_id") WHERE ("status" = 'active'::"text");

CREATE INDEX IF NOT EXISTS "idx_health_challenges_user" ON "public"."health_challenges" USING "btree" ("user_id", "status");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."health_challenges"
    ADD CONSTRAINT "health_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can insert own health challenges" ON "public"."health_challenges";
CREATE POLICY "Users can insert own health challenges" ON "public"."health_challenges" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own health challenges" ON "public"."health_challenges";
CREATE POLICY "Users can update own health challenges" ON "public"."health_challenges" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own health challenges" ON "public"."health_challenges";
CREATE POLICY "Users can view own health challenges" ON "public"."health_challenges" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."health_challenges" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."health_challenges" TO "anon";

GRANT ALL ON TABLE "public"."health_challenges" TO "authenticated";

GRANT ALL ON TABLE "public"."health_challenges" TO "service_role";

-- ============================================================
-- health_insights
-- ============================================================


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

COMMENT ON TABLE "public"."health_insights" IS 'AI分析結果（体重トレンド、血圧パターン、相関分析など）';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."health_insights"
    ADD CONSTRAINT "health_insights_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_health_insights_alerts" ON "public"."health_insights" USING "btree" ("user_id") WHERE (("is_alert" = true) AND ("is_dismissed" = false));

CREATE INDEX IF NOT EXISTS "idx_health_insights_unread" ON "public"."health_insights" USING "btree" ("user_id") WHERE ("is_read" = false);

CREATE INDEX IF NOT EXISTS "idx_health_insights_user" ON "public"."health_insights" USING "btree" ("user_id", "analysis_date" DESC);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."health_insights"
    ADD CONSTRAINT "health_insights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can update own health insights" ON "public"."health_insights";
CREATE POLICY "Users can update own health insights" ON "public"."health_insights" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own health insights" ON "public"."health_insights";
CREATE POLICY "Users can view own health insights" ON "public"."health_insights" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."health_insights" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."health_insights" TO "anon";

GRANT ALL ON TABLE "public"."health_insights" TO "authenticated";

GRANT ALL ON TABLE "public"."health_insights" TO "service_role";

-- ============================================================
-- inquiries
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."inquiries"
    ADD CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_inquiries_created_at" ON "public"."inquiries" USING "btree" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_inquiries_status" ON "public"."inquiries" USING "btree" ("status");

CREATE INDEX IF NOT EXISTS "idx_inquiries_user_id" ON "public"."inquiries" USING "btree" ("user_id");

CREATE OR REPLACE TRIGGER "trigger_inquiries_updated_at" BEFORE UPDATE ON "public"."inquiries" FOR EACH ROW EXECUTE FUNCTION "public"."update_inquiries_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."inquiries"
    ADD CONSTRAINT "inquiries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Admins can update inquiries" ON "public"."inquiries";
CREATE POLICY "Admins can update inquiries" ON "public"."inquiries" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"])))));

DROP POLICY IF EXISTS "Admins can view all inquiries" ON "public"."inquiries";
CREATE POLICY "Admins can view all inquiries" ON "public"."inquiries" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text"]))))));

DROP POLICY IF EXISTS "Anyone can create inquiries" ON "public"."inquiries";
CREATE POLICY "Anyone can create inquiries" ON "public"."inquiries" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own inquiries" ON "public"."inquiries";
CREATE POLICY "Users can view own inquiries" ON "public"."inquiries" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."inquiries" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."inquiries" TO "anon";

GRANT ALL ON TABLE "public"."inquiries" TO "authenticated";

GRANT ALL ON TABLE "public"."inquiries" TO "service_role";

-- ============================================================
-- iroca_calibration_shots
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."iroca_calibration_shots" (
    "id" bigint NOT NULL,
    "sample_name" "text" NOT NULL,
    "angles_deg" "jsonb",
    "visual_labs" "jsonb",
    "ccm_residual" "jsonb",
    "shot_metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE SEQUENCE IF NOT EXISTS "public"."iroca_calibration_shots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."iroca_calibration_shots_id_seq" OWNED BY "public"."iroca_calibration_shots"."id";

GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "anon";

GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "authenticated";

GRANT ALL ON SEQUENCE "public"."iroca_calibration_shots_id_seq" TO "service_role";

ALTER TABLE ONLY "public"."iroca_calibration_shots" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_calibration_shots_id_seq"'::"regclass");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."iroca_calibration_shots"
    ADD CONSTRAINT "iroca_calibration_shots_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_calib_shots_sample" ON "public"."iroca_calibration_shots" USING "btree" ("sample_name");

GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "anon";

GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "authenticated";

GRANT ALL ON TABLE "public"."iroca_calibration_shots" TO "service_role";

-- ============================================================
-- iroca_correction_model
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."iroca_correction_model" (
    "id" bigint NOT NULL,
    "model" "jsonb" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE SEQUENCE IF NOT EXISTS "public"."iroca_correction_model_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."iroca_correction_model_id_seq" OWNED BY "public"."iroca_correction_model"."id";

GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "anon";

GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "authenticated";

GRANT ALL ON SEQUENCE "public"."iroca_correction_model_id_seq" TO "service_role";

ALTER TABLE ONLY "public"."iroca_correction_model" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."iroca_correction_model_id_seq"'::"regclass");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."iroca_correction_model"
    ADD CONSTRAINT "iroca_correction_model_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

GRANT ALL ON TABLE "public"."iroca_correction_model" TO "anon";

GRANT ALL ON TABLE "public"."iroca_correction_model" TO "authenticated";

GRANT ALL ON TABLE "public"."iroca_correction_model" TO "service_role";

-- ============================================================
-- nutrition_feedback_cache
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_user_id_target_date_key" UNIQUE ("user_id", "target_date");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_nutrition_feedback_cache_user_date" ON "public"."nutrition_feedback_cache" USING "btree" ("user_id", "target_date");

CREATE OR REPLACE TRIGGER "nutrition_feedback_cache_updated_at" BEFORE UPDATE ON "public"."nutrition_feedback_cache" FOR EACH ROW EXECUTE FUNCTION "public"."update_nutrition_feedback_cache_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_feedback_cache"
    ADD CONSTRAINT "nutrition_feedback_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own nutrition feedback cache" ON "public"."nutrition_feedback_cache";
CREATE POLICY "Users can manage own nutrition feedback cache" ON "public"."nutrition_feedback_cache" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can select own nutrition feedback cache" ON "public"."nutrition_feedback_cache";
CREATE POLICY "Users can select own nutrition feedback cache" ON "public"."nutrition_feedback_cache" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."nutrition_feedback_cache" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "anon";

GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "authenticated";

GRANT ALL ON TABLE "public"."nutrition_feedback_cache" TO "service_role";

-- ============================================================
-- nutrition_targets
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_user_id_key" UNIQUE ("user_id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_nutrition_targets_user_id" ON "public"."nutrition_targets" USING "btree" ("user_id");

CREATE OR REPLACE TRIGGER "trigger_nutrition_targets_updated_at" BEFORE UPDATE ON "public"."nutrition_targets" FOR EACH ROW EXECUTE FUNCTION "public"."update_nutrition_targets_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."nutrition_targets"
    ADD CONSTRAINT "nutrition_targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can insert own nutrition targets" ON "public"."nutrition_targets";
CREATE POLICY "Users can insert own nutrition targets" ON "public"."nutrition_targets" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can update own nutrition targets" ON "public"."nutrition_targets";
CREATE POLICY "Users can update own nutrition targets" ON "public"."nutrition_targets" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can view own nutrition targets" ON "public"."nutrition_targets";
CREATE POLICY "Users can view own nutrition targets" ON "public"."nutrition_targets" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."nutrition_targets" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."nutrition_targets" TO "anon";

GRANT ALL ON TABLE "public"."nutrition_targets" TO "authenticated";

GRANT ALL ON TABLE "public"."nutrition_targets" TO "service_role";

-- ============================================================
-- org_daily_stats
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_organization_id_date_key" UNIQUE ("organization_id", "date");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_org_stats_date" ON "public"."org_daily_stats" USING "btree" ("date");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."org_daily_stats"
    ADD CONSTRAINT "org_daily_stats_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Org admins can view own stats" ON "public"."org_daily_stats";
CREATE POLICY "Org admins can view own stats" ON "public"."org_daily_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "org_daily_stats"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

ALTER TABLE "public"."org_daily_stats" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."org_daily_stats" TO "anon";

GRANT ALL ON TABLE "public"."org_daily_stats" TO "authenticated";

GRANT ALL ON TABLE "public"."org_daily_stats" TO "service_role";

-- ============================================================
-- organization_reports
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_reports"
    ADD CONSTRAINT "organization_reports_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_organization_reports_organization_id" ON "public"."organization_reports" USING "btree" ("organization_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organization_reports"
    ADD CONSTRAINT "organization_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Org admins can manage reports" ON "public"."organization_reports";
CREATE POLICY "Org admins can manage reports" ON "public"."organization_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_reports"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Org members can view reports" ON "public"."organization_reports";
CREATE POLICY "Org members can view reports" ON "public"."organization_reports" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_reports"."organization_id")))));

ALTER TABLE "public"."organization_reports" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."organization_reports" TO "anon";

GRANT ALL ON TABLE "public"."organization_reports" TO "authenticated";

GRANT ALL ON TABLE "public"."organization_reports" TO "service_role";

-- ============================================================
-- recipe_collection_items
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."recipe_collection_items" (
    "collection_id" "uuid" NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_pkey" PRIMARY KEY ("collection_id", "recipe_id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."recipe_collections"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_collection_items"
    ADD CONSTRAINT "recipe_collection_items_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Anyone can view public collection items" ON "public"."recipe_collection_items";
CREATE POLICY "Anyone can view public collection items" ON "public"."recipe_collection_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND (("recipe_collections"."is_public" = true) OR ("recipe_collections"."user_id" = "auth"."uid"()))))));

DROP POLICY IF EXISTS "Users can manage own collection items" ON "public"."recipe_collection_items";
CREATE POLICY "Users can manage own collection items" ON "public"."recipe_collection_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND ("recipe_collections"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."recipe_collections"
  WHERE (("recipe_collections"."id" = "recipe_collection_items"."collection_id") AND ("recipe_collections"."user_id" = "auth"."uid"())))));

ALTER TABLE "public"."recipe_collection_items" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."recipe_collection_items" TO "anon";

GRANT ALL ON TABLE "public"."recipe_collection_items" TO "authenticated";

GRANT ALL ON TABLE "public"."recipe_collection_items" TO "service_role";

-- ============================================================
-- recipe_comments
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."recipe_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid",
    "user_id" "uuid",
    "content" "text" NOT NULL,
    "rating" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "recipe_comments_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_recipe_comments_recipe_id" ON "public"."recipe_comments" USING "btree" ("recipe_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_comments"
    ADD CONSTRAINT "recipe_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Anyone can view comments" ON "public"."recipe_comments";
CREATE POLICY "Anyone can view comments" ON "public"."recipe_comments" FOR SELECT TO "authenticated" USING (true);

DROP POLICY IF EXISTS "Users can create comments" ON "public"."recipe_comments";
CREATE POLICY "Users can create comments" ON "public"."recipe_comments" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can delete own comments" ON "public"."recipe_comments";
CREATE POLICY "Users can delete own comments" ON "public"."recipe_comments" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can update own comments" ON "public"."recipe_comments";
CREATE POLICY "Users can update own comments" ON "public"."recipe_comments" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."recipe_comments" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."recipe_comments" TO "anon";

GRANT ALL ON TABLE "public"."recipe_comments" TO "authenticated";

GRANT ALL ON TABLE "public"."recipe_comments" TO "service_role";

-- ============================================================
-- recipe_flags
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_recipe_flags_status" ON "public"."recipe_flags" USING "btree" ("status");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."recipe_flags"
    ADD CONSTRAINT "recipe_flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Admins can update recipe flags" ON "public"."recipe_flags";
CREATE POLICY "Admins can update recipe flags" ON "public"."recipe_flags" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Anyone can create recipe flags" ON "public"."recipe_flags";
CREATE POLICY "Anyone can create recipe flags" ON "public"."recipe_flags" FOR INSERT TO "authenticated" WITH CHECK (("reporter_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users and admins can view recipe flags" ON "public"."recipe_flags";
CREATE POLICY "Users and admins can view recipe flags" ON "public"."recipe_flags" FOR SELECT USING ((("reporter_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"]))))));

ALTER TABLE "public"."recipe_flags" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."recipe_flags" TO "anon";

GRANT ALL ON TABLE "public"."recipe_flags" TO "authenticated";

GRANT ALL ON TABLE "public"."recipe_flags" TO "service_role";

-- ============================================================
-- segment_stats
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_segment_id_metric_id_period_type_period_start_key" UNIQUE ("segment_id", "metric_id", "period_type", "period_start");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_segment_stats_lookup" ON "public"."segment_stats" USING "btree" ("segment_id", "metric_id", "period_type", "period_start");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."segment_stats"
    ADD CONSTRAINT "segment_stats_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segment_definitions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."segment_stats" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "segment_stats_select" ON "public"."segment_stats";
CREATE POLICY "segment_stats_select" ON "public"."segment_stats" FOR SELECT USING (true);

GRANT ALL ON TABLE "public"."segment_stats" TO "anon";

GRANT ALL ON TABLE "public"."segment_stats" TO "authenticated";

GRANT ALL ON TABLE "public"."segment_stats" TO "service_role";

-- ============================================================
-- system_daily_stats
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."system_daily_stats"
    ADD CONSTRAINT "system_daily_stats_date_key" UNIQUE ("date");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."system_daily_stats"
    ADD CONSTRAINT "system_daily_stats_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_system_daily_stats_date" ON "public"."system_daily_stats" USING "btree" ("date" DESC);

DROP POLICY IF EXISTS "Admins can view system stats" ON "public"."system_daily_stats";
CREATE POLICY "Admins can view system stats" ON "public"."system_daily_stats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "System can insert stats" ON "public"."system_daily_stats";
CREATE POLICY "System can insert stats" ON "public"."system_daily_stats" FOR INSERT TO "authenticated" WITH CHECK (true);

ALTER TABLE "public"."system_daily_stats" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."system_daily_stats" TO "anon";

GRANT ALL ON TABLE "public"."system_daily_stats" TO "authenticated";

GRANT ALL ON TABLE "public"."system_daily_stats" TO "service_role";

-- ============================================================
-- system_settings
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Admins can view system settings" ON "public"."system_settings";
CREATE POLICY "Admins can view system settings" ON "public"."system_settings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Super admins can update system settings" ON "public"."system_settings";
CREATE POLICY "Super admins can update system settings" ON "public"."system_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ('super_admin'::"text" = ANY ("user_profiles"."roles"))))));

ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."system_settings" TO "anon";

GRANT ALL ON TABLE "public"."system_settings" TO "authenticated";

GRANT ALL ON TABLE "public"."system_settings" TO "service_role";

-- ============================================================
-- user_metrics
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_user_id_metric_id_period_type_period_start_key" UNIQUE ("user_id", "metric_id", "period_type", "period_start");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_user_metrics_lookup" ON "public"."user_metrics" USING "btree" ("user_id", "period_type", "period_start");

CREATE INDEX IF NOT EXISTS "idx_user_metrics_metric_period" ON "public"."user_metrics" USING "btree" ("metric_id", "period_type", "period_start");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_metrics"
    ADD CONSTRAINT "user_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."user_metrics" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_metrics_select" ON "public"."user_metrics";
CREATE POLICY "user_metrics_select" ON "public"."user_metrics" FOR SELECT USING (("auth"."uid"() = "user_id"));

GRANT ALL ON TABLE "public"."user_metrics" TO "anon";

GRANT ALL ON TABLE "public"."user_metrics" TO "authenticated";

GRANT ALL ON TABLE "public"."user_metrics" TO "service_role";

-- ============================================================
-- user_segment_rankings
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_user_id_segment_id_metric_id_period_t_key" UNIQUE ("user_id", "segment_id", "metric_id", "period_type", "period_start");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_user_segment_rankings_lookup" ON "public"."user_segment_rankings" USING "btree" ("user_id", "period_type", "period_start");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."segment_definitions"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."user_segment_rankings"
    ADD CONSTRAINT "user_segment_rankings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."user_segment_rankings" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_segment_rankings_select" ON "public"."user_segment_rankings";
CREATE POLICY "user_segment_rankings_select" ON "public"."user_segment_rankings" FOR SELECT USING (("auth"."uid"() = "user_id"));

GRANT ALL ON TABLE "public"."user_segment_rankings" TO "anon";

GRANT ALL ON TABLE "public"."user_segment_rankings" TO "authenticated";

GRANT ALL ON TABLE "public"."user_segment_rankings" TO "service_role";

-- ============================================================
-- weekly_menus
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."weekly_menus" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "content" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_weekly_menus_request_id" ON "public"."weekly_menus" USING "btree" ("request_id");

CREATE INDEX IF NOT EXISTS "idx_weekly_menus_user_id" ON "public"."weekly_menus" USING "btree" ("user_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."weekly_menu_requests"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."weekly_menus"
    ADD CONSTRAINT "weekly_menus_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can view their own menus" ON "public"."weekly_menus";
CREATE POLICY "Users can view their own menus" ON "public"."weekly_menus" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."weekly_menus" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."weekly_menus" TO "anon";

GRANT ALL ON TABLE "public"."weekly_menus" TO "authenticated";

GRANT ALL ON TABLE "public"."weekly_menus" TO "service_role";

-- ============================================================
-- legacy_family_groups
-- ============================================================


CREATE TABLE IF NOT EXISTS "public"."legacy_family_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "name" "text" DEFAULT '我が家'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."legacy_family_groups"
    ADD CONSTRAINT "family_groups_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_family_groups_owner_id" ON "public"."legacy_family_groups" USING "btree" ("owner_id");

CREATE OR REPLACE TRIGGER "trigger_family_groups_updated_at" BEFORE UPDATE ON "public"."legacy_family_groups" FOR EACH ROW EXECUTE FUNCTION "public"."update_family_groups_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."legacy_family_groups"
    ADD CONSTRAINT "family_groups_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage own family groups" ON "public"."legacy_family_groups";
CREATE POLICY "Users can manage own family groups" ON "public"."legacy_family_groups" TO "authenticated" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));

ALTER TABLE "public"."legacy_family_groups" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."legacy_family_groups" TO "anon";

GRANT ALL ON TABLE "public"."legacy_family_groups" TO "authenticated";

GRANT ALL ON TABLE "public"."legacy_family_groups" TO "service_role";

-- ============================================================
-- legacy_family_members
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_family_members_family_group_id" ON "public"."legacy_family_members" USING "btree" ("family_group_id");

CREATE INDEX IF NOT EXISTS "idx_family_members_user_id" ON "public"."legacy_family_members" USING "btree" ("user_id");

CREATE OR REPLACE TRIGGER "trigger_family_members_updated_at" BEFORE UPDATE ON "public"."legacy_family_members" FOR EACH ROW EXECUTE FUNCTION "public"."update_family_members_updated_at"();

DO $$ BEGIN
  ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_family_group_id_fkey" FOREIGN KEY ("family_group_id") REFERENCES "public"."legacy_family_groups"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."legacy_family_members"
    ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage members in own family groups" ON "public"."legacy_family_members";
CREATE POLICY "Users can manage members in own family groups" ON "public"."legacy_family_members" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."legacy_family_groups"
  WHERE (("legacy_family_groups"."id" = "legacy_family_members"."family_group_id") AND ("legacy_family_groups"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."legacy_family_groups"
  WHERE (("legacy_family_groups"."id" = "legacy_family_members"."family_group_id") AND ("legacy_family_groups"."owner_id" = "auth"."uid"())))));

ALTER TABLE "public"."legacy_family_members" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."legacy_family_members" TO "anon";

GRANT ALL ON TABLE "public"."legacy_family_members" TO "authenticated";

GRANT ALL ON TABLE "public"."legacy_family_members" TO "service_role";

-- ============================================================
-- family_meal_logs
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_family_meal_logs_family_member_id" ON "public"."family_meal_logs" USING "btree" ("family_member_id");

CREATE INDEX IF NOT EXISTS "idx_family_meal_logs_planned_meal_id" ON "public"."family_meal_logs" USING "btree" ("planned_meal_id");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_family_member_id_fkey" FOREIGN KEY ("family_member_id") REFERENCES "public"."legacy_family_members"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."family_meal_logs"
    ADD CONSTRAINT "family_meal_logs_planned_meal_id_fkey" FOREIGN KEY ("planned_meal_id") REFERENCES "public"."planned_meals"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can manage logs for own family members" ON "public"."family_meal_logs";
CREATE POLICY "Users can manage logs for own family members" ON "public"."family_meal_logs" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."legacy_family_members" "fm"
     JOIN "public"."legacy_family_groups" "fg" ON (("fm"."family_group_id" = "fg"."id")))
  WHERE (("fm"."id" = "family_meal_logs"."family_member_id") AND ("fg"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."legacy_family_members" "fm"
     JOIN "public"."legacy_family_groups" "fg" ON (("fm"."family_group_id" = "fg"."id")))
  WHERE (("fm"."id" = "family_meal_logs"."family_member_id") AND ("fg"."owner_id" = "auth"."uid"())))));

ALTER TABLE "public"."family_meal_logs" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."family_meal_logs" TO "anon";

GRANT ALL ON TABLE "public"."family_meal_logs" TO "authenticated";

GRANT ALL ON TABLE "public"."family_meal_logs" TO "service_role";

-- ============================================================
-- triggers
-- (先行定義と完全重複する6個は削除済み。以下は先行箇所に無い新規分のみ)
-- ============================================================


CREATE OR REPLACE TRIGGER "trigger_shopping_list_requests_updated_at" BEFORE UPDATE ON "public"."shopping_list_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_shopping_list_requests_updated_at"();

-- ============================================================
-- out-of-band indexes on existing tables (capture)
-- ============================================================


CREATE INDEX IF NOT EXISTS "idx_health_goals_user" ON "public"."health_goals" USING "btree" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "idx_health_records_bp" ON "public"."health_records" USING "btree" ("user_id", "record_date") WHERE ("systolic_bp" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_health_records_weight" ON "public"."health_records" USING "btree" ("user_id", "record_date") WHERE ("weight" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_health_streaks_user" ON "public"."health_streaks" USING "btree" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_created_at" ON "public"."llm_usage_logs" USING "btree" ("created_at");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_execution_id" ON "public"."llm_usage_logs" USING "btree" ("execution_id");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_function" ON "public"."llm_usage_logs" USING "btree" ("function_name");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_is_summary" ON "public"."llm_usage_logs" USING "btree" ("is_summary");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_request_id" ON "public"."llm_usage_logs" USING "btree" ("request_id");

CREATE INDEX IF NOT EXISTS "idx_llm_usage_logs_user_id" ON "public"."llm_usage_logs" USING "btree" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_organization_invites_email" ON "public"."organization_invites" USING "btree" ("email");

CREATE INDEX IF NOT EXISTS "idx_organization_invites_token" ON "public"."organization_invites" USING "btree" ("token");

CREATE INDEX IF NOT EXISTS "idx_planned_meals_is_generating" ON "public"."planned_meals" USING "btree" ("is_generating") WHERE ("is_generating" = true);

CREATE INDEX IF NOT EXISTS "idx_shopping_list_requests_meal_plan_id" ON "public"."shopping_list_requests" USING "btree" ("meal_plan_id");

CREATE INDEX IF NOT EXISTS "idx_shopping_list_requests_shopping_list_id" ON "public"."shopping_list_requests" USING "btree" ("shopping_list_id");

CREATE INDEX IF NOT EXISTS "idx_shopping_list_requests_user_id" ON "public"."shopping_list_requests" USING "btree" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_user_profiles_org_id" ON "public"."user_profiles" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_user_profiles_roles" ON "public"."user_profiles" USING "gin" ("roles");

CREATE INDEX IF NOT EXISTS "idx_weekly_menu_requests_mode" ON "public"."weekly_menu_requests" USING "btree" ("mode");

CREATE INDEX IF NOT EXISTS "idx_weekly_menu_requests_status_user" ON "public"."weekly_menu_requests" USING "btree" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "idx_weekly_menu_requests_updated_at" ON "public"."weekly_menu_requests" USING "btree" ("updated_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "user_push_tokens_user_token_uniq" ON "public"."user_push_tokens" USING "btree" ("user_id", "expo_push_token");

-- ============================================================
-- out-of-band policies on existing tables (capture)
-- ============================================================


DROP POLICY IF EXISTS "Admins can create audit logs" ON "public"."admin_audit_logs";
CREATE POLICY "Admins can create audit logs" ON "public"."admin_audit_logs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text", 'support'::"text", 'org_admin'::"text"])))));

DROP POLICY IF EXISTS "Admins can view audit logs" ON "public"."admin_audit_logs";
CREATE POLICY "Admins can view audit logs" ON "public"."admin_audit_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."roles" && ARRAY['admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Allow service role insert" ON "public"."app_logs";
CREATE POLICY "Allow service role insert" ON "public"."app_logs" FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can view likes" ON "public"."recipe_likes";
CREATE POLICY "Anyone can view likes" ON "public"."recipe_likes" FOR SELECT TO "authenticated" USING (true);

DROP POLICY IF EXISTS "Org admins can manage invites" ON "public"."organization_invites";
CREATE POLICY "Org admins can manage invites" ON "public"."organization_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."organization_id" = "organization_invites"."organization_id") AND ("user_profiles"."roles" && ARRAY['org_admin'::"text", 'admin'::"text", 'super_admin'::"text"])))));

DROP POLICY IF EXISTS "Service role can do everything" ON "public"."llm_usage_logs";
CREATE POLICY "Service role can do everything" ON "public"."llm_usage_logs" TO "service_role" USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update shopping list requests" ON "public"."shopping_list_requests";
CREATE POLICY "Service role can update shopping list requests" ON "public"."shopping_list_requests" FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Users can create own shopping list requests" ON "public"."shopping_list_requests";
CREATE POLICY "Users can create own shopping list requests" ON "public"."shopping_list_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can create their own requests" ON "public"."weekly_menu_requests";
CREATE POLICY "Users can create their own requests" ON "public"."weekly_menu_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can insert own notification preferences" ON "public"."notification_preferences";
CREATE POLICY "Users can insert own notification preferences" ON "public"."notification_preferences" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can manage own likes" ON "public"."recipe_likes";
CREATE POLICY "Users can manage own likes" ON "public"."recipe_likes" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

DROP POLICY IF EXISTS "Users can read own logs" ON "public"."app_logs";
CREATE POLICY "Users can read own logs" ON "public"."app_logs" FOR SELECT USING ((("auth"."uid"() = "user_id") OR ("user_id" IS NULL)));

DROP POLICY IF EXISTS "Users can select own llm usage logs" ON "public"."llm_usage_logs";
CREATE POLICY "Users can select own llm usage logs" ON "public"."llm_usage_logs" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own notification preferences" ON "public"."notification_preferences";
CREATE POLICY "Users can update own notification preferences" ON "public"."notification_preferences" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own notification preferences" ON "public"."notification_preferences";
CREATE POLICY "Users can view own notification preferences" ON "public"."notification_preferences" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own shopping list requests" ON "public"."shopping_list_requests";
CREATE POLICY "Users can view own shopping list requests" ON "public"."shopping_list_requests" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view their own requests" ON "public"."weekly_menu_requests";
CREATE POLICY "Users can view their own requests" ON "public"."weekly_menu_requests" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "delete_own_push_tokens" ON "public"."user_push_tokens";
CREATE POLICY "delete_own_push_tokens" ON "public"."user_push_tokens" FOR DELETE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "insert_own_push_tokens" ON "public"."user_push_tokens";
CREATE POLICY "insert_own_push_tokens" ON "public"."user_push_tokens" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "select_own_push_tokens" ON "public"."user_push_tokens";
CREATE POLICY "select_own_push_tokens" ON "public"."user_push_tokens" FOR SELECT USING (("auth"."uid"() = "user_id"));
