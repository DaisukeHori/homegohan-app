-- backfill: organizations / moderation_flags (policy は 20260508210000・20260511000103 が定義するため除外)

-- 本番へは migration repair --status applied で台帳登録のみ



-- ============================================================
-- organizations
-- ============================================================


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

COMMENT ON COLUMN "public"."organizations"."status" IS '組織状態: active / dissolved (operator が緊急解散時に dissolved)';

COMMENT ON COLUMN "public"."organizations"."dissolved_at" IS '解散実施時刻 (status = dissolved 時のみ NOT NULL)';

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_organizations_owner_id" ON "public"."organizations" USING "btree" ("owner_id");

CREATE INDEX IF NOT EXISTS "idx_organizations_status" ON "public"."organizations" USING "btree" ("status") WHERE ("status" = 'dissolved'::"text");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."organizations" TO "anon";

GRANT ALL ON TABLE "public"."organizations" TO "authenticated";

GRANT ALL ON TABLE "public"."organizations" TO "service_role";

-- ============================================================
-- moderation_flags
-- ============================================================


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

DO $$ BEGIN
  ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_moderation_flags_meal_id" ON "public"."moderation_flags" USING "btree" ("meal_id");

CREATE INDEX IF NOT EXISTS "idx_moderation_flags_status" ON "public"."moderation_flags" USING "btree" ("status");

DO $$ BEGIN
  ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ONLY "public"."moderation_flags"
    ADD CONSTRAINT "moderation_flags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; WHEN invalid_table_definition THEN NULL; END $$;

ALTER TABLE "public"."moderation_flags" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."moderation_flags" TO "anon";

GRANT ALL ON TABLE "public"."moderation_flags" TO "authenticated";

GRANT ALL ON TABLE "public"."moderation_flags" TO "service_role";
