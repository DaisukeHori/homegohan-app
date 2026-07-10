-- backfill (out-of-band 適用済み DDL の repo 取り込み / 本番へは migration repair --status applied で台帳登録のみ)

-- source: 本番 prod_public.sql dump (2026-07-10) から抽出



-- ============================================================
-- blood_test_results
-- ============================================================


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

COMMENT ON TABLE "public"."blood_test_results" IS '血液検査結果（健康診断データ）';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."blood_test_results"
    ADD CONSTRAINT "blood_test_results_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_blood_test_user_date" ON "public"."blood_test_results" USING "btree" ("user_id", "test_date" DESC);

DO $$ BEGIN
  ALTER TABLE ONLY "public"."blood_test_results"
    ADD CONSTRAINT "blood_test_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DROP POLICY IF EXISTS "Users can delete own blood test results" ON "public"."blood_test_results";
CREATE POLICY "Users can delete own blood test results" ON "public"."blood_test_results" FOR DELETE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can insert own blood test results" ON "public"."blood_test_results";
CREATE POLICY "Users can insert own blood test results" ON "public"."blood_test_results" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own blood test results" ON "public"."blood_test_results";
CREATE POLICY "Users can update own blood test results" ON "public"."blood_test_results" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own blood test results" ON "public"."blood_test_results";
CREATE POLICY "Users can view own blood test results" ON "public"."blood_test_results" FOR SELECT USING (("auth"."uid"() = "user_id"));

ALTER TABLE "public"."blood_test_results" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."blood_test_results" TO "anon";

GRANT ALL ON TABLE "public"."blood_test_results" TO "authenticated";

GRANT ALL ON TABLE "public"."blood_test_results" TO "service_role";
