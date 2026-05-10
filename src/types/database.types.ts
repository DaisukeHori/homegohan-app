export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      admin_audit_logs: {
        Row: {
          action_type: string
          actor_email_snapshot: string | null
          actor_id: string | null
          actor_role_snapshot: string | null
          created_at: string | null
          details: Json | null
          id: string
          impersonated_by: string | null
          ip_address: unknown
          session_id: string | null
          severity: string
          target_id: string | null
          target_type: string | null
          user_agent: string | null
        }
        Insert: {
          action_type: string
          actor_email_snapshot?: string | null
          actor_id?: string | null
          actor_role_snapshot?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          impersonated_by?: string | null
          ip_address?: unknown
          session_id?: string | null
          severity?: string
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
        }
        Update: {
          action_type?: string
          actor_email_snapshot?: string | null
          actor_id?: string | null
          actor_role_snapshot?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          impersonated_by?: string | null
          ip_address?: unknown
          session_id?: string | null
          severity?: string
          target_id?: string | null
          target_type?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      admin_user_notes: {
        Row: {
          admin_id: string | null
          created_at: string | null
          id: string
          note: string
          user_id: string | null
        }
        Insert: {
          admin_id?: string | null
          created_at?: string | null
          id?: string
          note: string
          user_id?: string | null
        }
        Update: {
          admin_id?: string | null
          created_at?: string | null
          id?: string
          note?: string
          user_id?: string | null
        }
        Relationships: []
      }
      ai_action_logs: {
        Row: {
          action_params: Json
          action_type: string
          created_at: string | null
          executed_at: string | null
          id: string
          message_id: string | null
          result: Json | null
          session_id: string | null
          status: string | null
        }
        Insert: {
          action_params: Json
          action_type: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          message_id?: string | null
          result?: Json | null
          session_id?: string | null
          status?: string | null
        }
        Update: {
          action_params?: Json
          action_type?: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          message_id?: string | null
          result?: Json | null
          session_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_action_logs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ai_consultation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_action_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_consultation_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_action_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "user_consultation_history"
            referencedColumns: ["session_id"]
          },
        ]
      }
      ai_consultation_messages: {
        Row: {
          content: string
          created_at: string | null
          id: string
          importance_reason: string | null
          is_important: boolean | null
          metadata: Json | null
          proposed_actions: Json | null
          role: string
          session_id: string | null
          tokens_used: number | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          importance_reason?: string | null
          is_important?: boolean | null
          metadata?: Json | null
          proposed_actions?: Json | null
          role: string
          session_id?: string | null
          tokens_used?: number | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          importance_reason?: string | null
          is_important?: boolean | null
          metadata?: Json | null
          proposed_actions?: Json | null
          role?: string
          session_id?: string | null
          tokens_used?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_consultation_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_consultation_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_consultation_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "user_consultation_history"
            referencedColumns: ["session_id"]
          },
        ]
      }
      ai_consultation_sessions: {
        Row: {
          action_history: Json | null
          context_snapshot: Json | null
          created_at: string | null
          id: string
          key_topics: string[] | null
          status: string | null
          summary: string | null
          summary_generated_at: string | null
          title: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          action_history?: Json | null
          context_snapshot?: Json | null
          created_at?: string | null
          id?: string
          key_topics?: string[] | null
          status?: string | null
          summary?: string | null
          summary_generated_at?: string | null
          title?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          action_history?: Json | null
          context_snapshot?: Json | null
          created_at?: string | null
          id?: string
          key_topics?: string[] | null
          status?: string | null
          summary?: string | null
          summary_generated_at?: string | null
          title?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      ai_content_logs: {
        Row: {
          content_type: string
          cost_usd: number | null
          created_at: string | null
          flag_reason: string | null
          flagged: boolean | null
          id: string
          input_prompt: string | null
          model_name: string | null
          output_content: string | null
          tokens_used: number | null
          user_id: string | null
        }
        Insert: {
          content_type?: string
          cost_usd?: number | null
          created_at?: string | null
          flag_reason?: string | null
          flagged?: boolean | null
          id?: string
          input_prompt?: string | null
          model_name?: string | null
          output_content?: string | null
          tokens_used?: number | null
          user_id?: string | null
        }
        Update: {
          content_type?: string
          cost_usd?: number | null
          created_at?: string | null
          flag_reason?: string | null
          flagged?: boolean | null
          id?: string
          input_prompt?: string | null
          model_name?: string | null
          output_content?: string | null
          tokens_used?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      announcement_reads: {
        Row: {
          announcement_id: string
          read_at: string | null
          user_id: string
        }
        Insert: {
          announcement_id: string
          read_at?: string | null
          user_id: string
        }
        Update: {
          announcement_id?: string
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          category: string | null
          content: string
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          id: string
          image_url: string | null
          is_public: boolean | null
          priority: number | null
          published_at: string | null
          target_audience: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          content: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_public?: boolean | null
          priority?: number | null
          published_at?: string | null
          target_audience?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          content?: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_public?: boolean | null
          priority?: number | null
          published_at?: string | null
          target_audience?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      app_logs: {
        Row: {
          created_at: string
          error_message: string | null
          error_stack: string | null
          function_name: string | null
          id: string
          level: string
          message: string
          metadata: Json | null
          request_id: string | null
          source: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          error_stack?: string | null
          function_name?: string | null
          id?: string
          level?: string
          message: string
          metadata?: Json | null
          request_id?: string | null
          source: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          error_stack?: string | null
          function_name?: string | null
          id?: string
          level?: string
          message?: string
          metadata?: Json | null
          request_id?: string | null
          source?: string
          user_id?: string | null
        }
        Relationships: []
      }
      badges: {
        Row: {
          code: string
          condition_json: Json | null
          created_at: string | null
          description: string | null
          icon: string | null
          id: string
          metric_code: string | null
          name: string
          priority: number | null
        }
        Insert: {
          code: string
          condition_json?: Json | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          metric_code?: string | null
          name: string
          priority?: number | null
        }
        Update: {
          code?: string
          condition_json?: Json | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          metric_code?: string | null
          name?: string
          priority?: number | null
        }
        Relationships: []
      }
      blood_test_longitudinal_reviews: {
        Row: {
          blood_test_ids: string[]
          created_at: string | null
          id: string
          nutrition_guidance: Json | null
          review_date: string | null
          trend_analysis: Json | null
          user_id: string
        }
        Insert: {
          blood_test_ids: string[]
          created_at?: string | null
          id?: string
          nutrition_guidance?: Json | null
          review_date?: string | null
          trend_analysis?: Json | null
          user_id: string
        }
        Update: {
          blood_test_ids?: string[]
          created_at?: string | null
          id?: string
          nutrition_guidance?: Json | null
          review_date?: string | null
          trend_analysis?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      blood_test_results: {
        Row: {
          ai_review: Json | null
          albumin: number | null
          alt: number | null
          ast: number | null
          bun: number | null
          created_at: string | null
          creatinine: number | null
          egfr: number | null
          fasting_glucose: number | null
          gamma_gtp: number | null
          hba1c: number | null
          hdl_cholesterol: number | null
          hematocrit: number | null
          hemoglobin: number | null
          id: string
          ldl_cholesterol: number | null
          note: string | null
          other_results: Json | null
          platelets: number | null
          rbc: number | null
          report_image_url: string | null
          test_date: string
          test_facility: string | null
          total_bilirubin: number | null
          total_cholesterol: number | null
          total_protein: number | null
          triglycerides: number | null
          updated_at: string | null
          uric_acid: number | null
          user_id: string
          wbc: number | null
        }
        Insert: {
          ai_review?: Json | null
          albumin?: number | null
          alt?: number | null
          ast?: number | null
          bun?: number | null
          created_at?: string | null
          creatinine?: number | null
          egfr?: number | null
          fasting_glucose?: number | null
          gamma_gtp?: number | null
          hba1c?: number | null
          hdl_cholesterol?: number | null
          hematocrit?: number | null
          hemoglobin?: number | null
          id?: string
          ldl_cholesterol?: number | null
          note?: string | null
          other_results?: Json | null
          platelets?: number | null
          rbc?: number | null
          report_image_url?: string | null
          test_date: string
          test_facility?: string | null
          total_bilirubin?: number | null
          total_cholesterol?: number | null
          total_protein?: number | null
          triglycerides?: number | null
          updated_at?: string | null
          uric_acid?: number | null
          user_id: string
          wbc?: number | null
        }
        Update: {
          ai_review?: Json | null
          albumin?: number | null
          alt?: number | null
          ast?: number | null
          bun?: number | null
          created_at?: string | null
          creatinine?: number | null
          egfr?: number | null
          fasting_glucose?: number | null
          gamma_gtp?: number | null
          hba1c?: number | null
          hdl_cholesterol?: number | null
          hematocrit?: number | null
          hemoglobin?: number | null
          id?: string
          ldl_cholesterol?: number | null
          note?: string | null
          other_results?: Json | null
          platelets?: number | null
          rbc?: number | null
          report_image_url?: string | null
          test_date?: string
          test_facility?: string | null
          total_bilirubin?: number | null
          total_cholesterol?: number | null
          total_protein?: number | null
          triglycerides?: number | null
          updated_at?: string | null
          uric_acid?: number | null
          user_id?: string
          wbc?: number | null
        }
        Relationships: []
      }
      buddies: {
        Row: {
          created_at: string | null
          id: string
          status: string | null
          user_id_1: string | null
          user_id_2: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          status?: string | null
          user_id_1?: string | null
          user_id_2?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          status?: string | null
          user_id_1?: string | null
          user_id_2?: string | null
        }
        Relationships: []
      }
      buddy_actions: {
        Row: {
          action_type: string
          created_at: string | null
          from_user_id: string | null
          id: string
          to_user_id: string | null
        }
        Insert: {
          action_type: string
          created_at?: string | null
          from_user_id?: string | null
          id?: string
          to_user_id?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string | null
          from_user_id?: string | null
          id?: string
          to_user_id?: string | null
        }
        Relationships: []
      }
      catalog_import_runs: {
        Row: {
          categories_total: number
          category_code: string | null
          completed_at: string | null
          created_at: string
          error_log: string | null
          id: string
          metadata_json: Json
          notes: string | null
          pages_total: number
          products_discontinued: number
          products_inserted: number
          products_seen: number
          products_unchanged: number
          products_updated: number
          source_code: string
          source_id: string
          started_at: string
          status: string
          trigger_type: string
          updated_at: string
        }
        Insert: {
          categories_total?: number
          category_code?: string | null
          completed_at?: string | null
          created_at?: string
          error_log?: string | null
          id?: string
          metadata_json?: Json
          notes?: string | null
          pages_total?: number
          products_discontinued?: number
          products_inserted?: number
          products_seen?: number
          products_unchanged?: number
          products_updated?: number
          source_code: string
          source_id: string
          started_at?: string
          status?: string
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          categories_total?: number
          category_code?: string | null
          completed_at?: string | null
          created_at?: string
          error_log?: string | null
          id?: string
          metadata_json?: Json
          notes?: string | null
          pages_total?: number
          products_discontinued?: number
          products_inserted?: number
          products_seen?: number
          products_unchanged?: number
          products_updated?: number
          source_code?: string
          source_id?: string
          started_at?: string
          status?: string
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_import_runs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "catalog_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_product_snapshots: {
        Row: {
          allergens_json: Json
          availability_status: string | null
          calories_kcal: number | null
          captured_at: string
          carbs_g: number | null
          fat_g: number | null
          fiber_g: number | null
          id: string
          import_run_id: string | null
          main_image_url: string | null
          metadata_json: Json
          name: string
          nutrition_json: Json
          price_yen: number | null
          product_id: string
          protein_g: number | null
          snapshot_hash: string
          sodium_g: number | null
          sugar_g: number | null
        }
        Insert: {
          allergens_json?: Json
          availability_status?: string | null
          calories_kcal?: number | null
          captured_at?: string
          carbs_g?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          id?: string
          import_run_id?: string | null
          main_image_url?: string | null
          metadata_json?: Json
          name: string
          nutrition_json?: Json
          price_yen?: number | null
          product_id: string
          protein_g?: number | null
          snapshot_hash: string
          sodium_g?: number | null
          sugar_g?: number | null
        }
        Update: {
          allergens_json?: Json
          availability_status?: string | null
          calories_kcal?: number | null
          captured_at?: string
          carbs_g?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          id?: string
          import_run_id?: string | null
          main_image_url?: string | null
          metadata_json?: Json
          name?: string
          nutrition_json?: Json
          price_yen?: number | null
          product_id?: string
          protein_g?: number | null
          snapshot_hash?: string
          sodium_g?: number | null
          sugar_g?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "catalog_product_snapshots_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "catalog_import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "catalog_product_snapshots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "catalog_products"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_products: {
        Row: {
          allergens_json: Json
          availability_status: string
          brand_name: string
          calories_kcal: number | null
          canonical_url: string
          carbs_g: number | null
          category_code: string | null
          content_hash: string
          created_at: string
          description: string | null
          discontinued_at: string | null
          external_id: string
          fat_g: number | null
          fiber_g: number | null
          first_seen_at: string
          id: string
          last_seen_at: string | null
          main_image_url: string | null
          metadata_json: Json
          name: string
          name_norm: string
          nutrition_json: Json
          price_yen: number | null
          protein_g: number | null
          sales_region: string | null
          sodium_g: number | null
          source_id: string
          subcategory_code: string | null
          sugar_g: number | null
          updated_at: string
        }
        Insert: {
          allergens_json?: Json
          availability_status?: string
          brand_name: string
          calories_kcal?: number | null
          canonical_url: string
          carbs_g?: number | null
          category_code?: string | null
          content_hash: string
          created_at?: string
          description?: string | null
          discontinued_at?: string | null
          external_id: string
          fat_g?: number | null
          fiber_g?: number | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string | null
          main_image_url?: string | null
          metadata_json?: Json
          name: string
          name_norm: string
          nutrition_json?: Json
          price_yen?: number | null
          protein_g?: number | null
          sales_region?: string | null
          sodium_g?: number | null
          source_id: string
          subcategory_code?: string | null
          sugar_g?: number | null
          updated_at?: string
        }
        Update: {
          allergens_json?: Json
          availability_status?: string
          brand_name?: string
          calories_kcal?: number | null
          canonical_url?: string
          carbs_g?: number | null
          category_code?: string | null
          content_hash?: string
          created_at?: string
          description?: string | null
          discontinued_at?: string | null
          external_id?: string
          fat_g?: number | null
          fiber_g?: number | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string | null
          main_image_url?: string | null
          metadata_json?: Json
          name?: string
          name_norm?: string
          nutrition_json?: Json
          price_yen?: number | null
          protein_g?: number | null
          sales_region?: string | null
          sodium_g?: number | null
          source_id?: string
          subcategory_code?: string | null
          sugar_g?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_products_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "catalog_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_raw_documents: {
        Row: {
          category_code: string | null
          content_sha256: string
          document_type: string
          fetched_at: string
          http_status: number | null
          id: string
          import_run_id: string | null
          payload: Json
          source_id: string
          url: string
        }
        Insert: {
          category_code?: string | null
          content_sha256: string
          document_type: string
          fetched_at?: string
          http_status?: number | null
          id?: string
          import_run_id?: string | null
          payload?: Json
          source_id: string
          url: string
        }
        Update: {
          category_code?: string | null
          content_sha256?: string
          document_type?: string
          fetched_at?: string
          http_status?: number | null
          id?: string
          import_run_id?: string | null
          payload?: Json
          source_id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_raw_documents_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "catalog_import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "catalog_raw_documents_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "catalog_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_source_categories: {
        Row: {
          category_code: string
          category_name: string
          crawl_priority: number
          created_at: string
          id: string
          is_active: boolean
          last_crawled_at: string | null
          list_url: string
          metadata_json: Json
          source_id: string
          updated_at: string
        }
        Insert: {
          category_code: string
          category_name: string
          crawl_priority?: number
          created_at?: string
          id?: string
          is_active?: boolean
          last_crawled_at?: string | null
          list_url: string
          metadata_json?: Json
          source_id: string
          updated_at?: string
        }
        Update: {
          category_code?: string
          category_name?: string
          crawl_priority?: number
          created_at?: string
          id?: string
          is_active?: boolean
          last_crawled_at?: string | null
          list_url?: string
          metadata_json?: Json
          source_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "catalog_source_categories_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "catalog_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_sources: {
        Row: {
          base_url: string | null
          brand_name: string
          code: string
          country_code: string
          crawl_interval_minutes: number
          created_at: string
          id: string
          is_active: boolean
          metadata_json: Json
          rate_limit_per_minute: number
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          brand_name: string
          code: string
          country_code?: string
          crawl_interval_minutes?: number
          created_at?: string
          id?: string
          is_active?: boolean
          metadata_json?: Json
          rate_limit_per_minute?: number
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          brand_name?: string
          code?: string
          country_code?: string
          crawl_interval_minutes?: number
          created_at?: string
          id?: string
          is_active?: boolean
          metadata_json?: Json
          rate_limit_per_minute?: number
          updated_at?: string
        }
        Relationships: []
      }
      cookie_consents: {
        Row: {
          advertising: boolean
          analytics: boolean
          consented_at: string
          id: string
          ip_address: unknown
          session_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          advertising?: boolean
          analytics?: boolean
          consented_at?: string
          id?: string
          ip_address?: unknown
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          advertising?: boolean
          analytics?: boolean
          consented_at?: string
          id?: string
          ip_address?: unknown
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      coupon_redemptions: {
        Row: {
          applied_retroactively: boolean
          applied_to_subscription_id: string
          approved_by: string | null
          coupon_id: string
          discount_amount_jpy: number
          duration_months: number | null
          end_reason: string | null
          ended_at: string | null
          id: string
          organization_id: string | null
          redeemed_at: string
          subscription_target: string
          user_id: string | null
        }
        Insert: {
          applied_retroactively?: boolean
          applied_to_subscription_id: string
          approved_by?: string | null
          coupon_id: string
          discount_amount_jpy: number
          duration_months?: number | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          organization_id?: string | null
          redeemed_at?: string
          subscription_target: string
          user_id?: string | null
        }
        Update: {
          applied_retroactively?: boolean
          applied_to_subscription_id?: string
          approved_by?: string | null
          coupon_id?: string
          discount_amount_jpy?: number
          duration_months?: number | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          organization_id?: string | null
          redeemed_at?: string
          subscription_target?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          applicable_plans: string[]
          applicable_to: string
          code: string
          created_at: string
          created_by: string
          discount_type: string
          discount_value: number
          display_name: string | null
          duration_months: number | null
          gross_margin_preview_jpy: number | null
          id: string
          max_uses: number | null
          per_user_limit: number
          status: string
          uses_count: number
          valid_from: string
          valid_until: string
        }
        Insert: {
          applicable_plans?: string[]
          applicable_to?: string
          code: string
          created_at?: string
          created_by: string
          discount_type: string
          discount_value: number
          display_name?: string | null
          duration_months?: number | null
          gross_margin_preview_jpy?: number | null
          id?: string
          max_uses?: number | null
          per_user_limit?: number
          status?: string
          uses_count?: number
          valid_from: string
          valid_until: string
        }
        Update: {
          applicable_plans?: string[]
          applicable_to?: string
          code?: string
          created_at?: string
          created_by?: string
          discount_type?: string
          discount_value?: number
          display_name?: string | null
          duration_months?: number | null
          gross_margin_preview_jpy?: number | null
          id?: string
          max_uses?: number | null
          per_user_limit?: number
          status?: string
          uses_count?: number
          valid_from?: string
          valid_until?: string
        }
        Relationships: []
      }
      csat_feedbacks: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          score: number
          ticket_id: string | null
          user_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          score: number
          ticket_id?: string | null
          user_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          score?: number
          ticket_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "csat_feedbacks_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_active_users: {
        Row: {
          computed_at: string
          date: string
          dau: number
          mau: number
          plan_key: string
          plan_type: string
          wau: number
        }
        Insert: {
          computed_at?: string
          date: string
          dau?: number
          mau?: number
          plan_key?: string
          plan_type: string
          wau?: number
        }
        Update: {
          computed_at?: string
          date?: string
          dau?: number
          mau?: number
          plan_key?: string
          plan_type?: string
          wau?: number
        }
        Relationships: []
      }
      daily_activity_logs: {
        Row: {
          calories_burned: number | null
          created_at: string | null
          date: string
          feeling: string | null
          id: string
          steps: number | null
          user_id: string | null
        }
        Insert: {
          calories_burned?: number | null
          created_at?: string | null
          date: string
          feeling?: string | null
          id?: string
          steps?: number | null
          user_id?: string | null
        }
        Update: {
          calories_burned?: number | null
          created_at?: string | null
          date?: string
          feeling?: string | null
          id?: string
          steps?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      dataset_import_runs: {
        Row: {
          completed_at: string | null
          dataset_version: string
          error_log: string | null
          id: string
          ingredients_inserted: number | null
          ingredients_total: number | null
          menu_sets_inserted: number | null
          menu_sets_total: number | null
          notes: string | null
          recipes_inserted: number | null
          recipes_total: number | null
          source: string | null
          started_at: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          dataset_version: string
          error_log?: string | null
          id?: string
          ingredients_inserted?: number | null
          ingredients_total?: number | null
          menu_sets_inserted?: number | null
          menu_sets_total?: number | null
          notes?: string | null
          recipes_inserted?: number | null
          recipes_total?: number | null
          source?: string | null
          started_at?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          dataset_version?: string
          error_log?: string | null
          id?: string
          ingredients_inserted?: number | null
          ingredients_total?: number | null
          menu_sets_inserted?: number | null
          menu_sets_total?: number | null
          notes?: string | null
          recipes_inserted?: number | null
          recipes_total?: number | null
          source?: string | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      dataset_ingredients: {
        Row: {
          alcohol_g: number | null
          ash_g: number | null
          available_carbs_diff_g: number | null
          available_carbs_mass_g: number | null
          available_carbs_mono_eq_g: number | null
          biotin_ug: number | null
          calcium_mg: number | null
          calories_kcal: number | null
          carbs_g: number | null
          cholesterol_mg: number | null
          chromium_ug: number | null
          copper_mg: number | null
          created_at: string | null
          discard_rate_percent: number | null
          fat_fa_tg_g: number | null
          fat_g: number | null
          fiber_g: number | null
          folic_acid_ug: number | null
          id: string
          iodine_ug: number | null
          iron_mg: number | null
          magnesium_mg: number | null
          manganese_mg: number | null
          molybdenum_ug: number | null
          name: string
          name_embedding: string | null
          name_norm: string
          niacin_eq_mg: number | null
          niacin_mg: number | null
          notes: string | null
          organic_acid_g: number | null
          pantothenic_acid_mg: number | null
          phosphorus_mg: number | null
          potassium_mg: number | null
          protein_aa_g: number | null
          protein_g: number | null
          salt_eq_g: number | null
          selenium_ug: number | null
          sodium_mg: number | null
          sugar_alcohol_g: number | null
          updated_at: string | null
          vitamin_a_alpha_carotene_ug: number | null
          vitamin_a_beta_carotene_eq_ug: number | null
          vitamin_a_beta_carotene_ug: number | null
          vitamin_a_beta_cryptoxanthin_ug: number | null
          vitamin_a_retinol_ug: number | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_alpha_mg: number | null
          vitamin_e_beta_mg: number | null
          vitamin_e_delta_mg: number | null
          vitamin_e_gamma_mg: number | null
          vitamin_k_ug: number | null
          water_g: number | null
          zinc_mg: number | null
        }
        Insert: {
          alcohol_g?: number | null
          ash_g?: number | null
          available_carbs_diff_g?: number | null
          available_carbs_mass_g?: number | null
          available_carbs_mono_eq_g?: number | null
          biotin_ug?: number | null
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          chromium_ug?: number | null
          copper_mg?: number | null
          created_at?: string | null
          discard_rate_percent?: number | null
          fat_fa_tg_g?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          manganese_mg?: number | null
          molybdenum_ug?: number | null
          name: string
          name_embedding?: string | null
          name_norm: string
          niacin_eq_mg?: number | null
          niacin_mg?: number | null
          notes?: string | null
          organic_acid_g?: number | null
          pantothenic_acid_mg?: number | null
          phosphorus_mg?: number | null
          potassium_mg?: number | null
          protein_aa_g?: number | null
          protein_g?: number | null
          salt_eq_g?: number | null
          selenium_ug?: number | null
          sodium_mg?: number | null
          sugar_alcohol_g?: number | null
          updated_at?: string | null
          vitamin_a_alpha_carotene_ug?: number | null
          vitamin_a_beta_carotene_eq_ug?: number | null
          vitamin_a_beta_carotene_ug?: number | null
          vitamin_a_beta_cryptoxanthin_ug?: number | null
          vitamin_a_retinol_ug?: number | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_alpha_mg?: number | null
          vitamin_e_beta_mg?: number | null
          vitamin_e_delta_mg?: number | null
          vitamin_e_gamma_mg?: number | null
          vitamin_k_ug?: number | null
          water_g?: number | null
          zinc_mg?: number | null
        }
        Update: {
          alcohol_g?: number | null
          ash_g?: number | null
          available_carbs_diff_g?: number | null
          available_carbs_mass_g?: number | null
          available_carbs_mono_eq_g?: number | null
          biotin_ug?: number | null
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          chromium_ug?: number | null
          copper_mg?: number | null
          created_at?: string | null
          discard_rate_percent?: number | null
          fat_fa_tg_g?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          manganese_mg?: number | null
          molybdenum_ug?: number | null
          name?: string
          name_embedding?: string | null
          name_norm?: string
          niacin_eq_mg?: number | null
          niacin_mg?: number | null
          notes?: string | null
          organic_acid_g?: number | null
          pantothenic_acid_mg?: number | null
          phosphorus_mg?: number | null
          potassium_mg?: number | null
          protein_aa_g?: number | null
          protein_g?: number | null
          salt_eq_g?: number | null
          selenium_ug?: number | null
          sodium_mg?: number | null
          sugar_alcohol_g?: number | null
          updated_at?: string | null
          vitamin_a_alpha_carotene_ug?: number | null
          vitamin_a_beta_carotene_eq_ug?: number | null
          vitamin_a_beta_carotene_ug?: number | null
          vitamin_a_beta_cryptoxanthin_ug?: number | null
          vitamin_a_retinol_ug?: number | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_alpha_mg?: number | null
          vitamin_e_beta_mg?: number | null
          vitamin_e_delta_mg?: number | null
          vitamin_e_gamma_mg?: number | null
          vitamin_k_ug?: number | null
          water_g?: number | null
          zinc_mg?: number | null
        }
        Relationships: []
      }
      dataset_menu_sets: {
        Row: {
          calcium_mg: number | null
          calories_kcal: number | null
          carbs_g: number | null
          cholesterol_mg: number | null
          content_embedding: string | null
          created_at: string | null
          dish_count: number
          dishes: Json
          external_id: string
          fat_g: number | null
          fiber_g: number | null
          fiber_soluble_g: number | null
          folic_acid_ug: number | null
          id: string
          iodine_ug: number | null
          iron_mg: number | null
          magnesium_mg: number | null
          meal_type_hint: string | null
          monounsaturated_fat_g: number | null
          phosphorus_mg: number | null
          polyunsaturated_fat_g: number | null
          potassium_mg: number | null
          protein_g: number | null
          saturated_fat_g: number | null
          sodium_g: number | null
          source_url: string | null
          sugar_g: number | null
          theme_raw: string | null
          theme_tags: string[] | null
          title: string
          updated_at: string | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_mg: number | null
          vitamin_k_ug: number | null
          zinc_mg: number | null
        }
        Insert: {
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          content_embedding?: string | null
          created_at?: string | null
          dish_count?: number
          dishes?: Json
          external_id: string
          fat_g?: number | null
          fiber_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          meal_type_hint?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_url?: string | null
          sugar_g?: number | null
          theme_raw?: string | null
          theme_tags?: string[] | null
          title: string
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Update: {
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          content_embedding?: string | null
          created_at?: string | null
          dish_count?: number
          dishes?: Json
          external_id?: string
          fat_g?: number | null
          fiber_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          meal_type_hint?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_url?: string | null
          sugar_g?: number | null
          theme_raw?: string | null
          theme_tags?: string[] | null
          title?: string
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Relationships: []
      }
      dataset_recipes: {
        Row: {
          calcium_mg: number | null
          calories_kcal: number | null
          carbs_g: number | null
          cholesterol_mg: number | null
          created_at: string | null
          external_id: string
          fat_g: number | null
          fiber_g: number | null
          fiber_insoluble_g: number | null
          fiber_soluble_g: number | null
          folic_acid_ug: number | null
          id: string
          ingredients_text: string | null
          instructions_text: string | null
          iodine_ug: number | null
          iron_mg: number | null
          monounsaturated_fat_g: number | null
          name: string
          name_embedding: string | null
          name_norm: string
          phosphorus_mg: number | null
          polyunsaturated_fat_g: number | null
          potassium_mg: number | null
          protein_g: number | null
          saturated_fat_g: number | null
          sodium_g: number | null
          source_url: string | null
          sugar_g: number | null
          tag_raw: string | null
          target_audience_raw: string | null
          updated_at: string | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_mg: number | null
          vitamin_k_ug: number | null
          zinc_mg: number | null
        }
        Insert: {
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          external_id: string
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          ingredients_text?: string | null
          instructions_text?: string | null
          iodine_ug?: number | null
          iron_mg?: number | null
          monounsaturated_fat_g?: number | null
          name: string
          name_embedding?: string | null
          name_norm: string
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_url?: string | null
          sugar_g?: number | null
          tag_raw?: string | null
          target_audience_raw?: string | null
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Update: {
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          external_id?: string
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          ingredients_text?: string | null
          instructions_text?: string | null
          iodine_ug?: number | null
          iron_mg?: number | null
          monounsaturated_fat_g?: number | null
          name?: string
          name_embedding?: string | null
          name_norm?: string
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_url?: string | null
          sugar_g?: number | null
          tag_raw?: string | null
          target_audience_raw?: string | null
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Relationships: []
      }
      departments: {
        Row: {
          created_at: string | null
          display_order: number | null
          id: string
          manager_id: string | null
          name: string
          organization_id: string | null
          parent_id: string | null
        }
        Insert: {
          created_at?: string | null
          display_order?: number | null
          id?: string
          manager_id?: string | null
          name: string
          organization_id?: string | null
          parent_id?: string | null
        }
        Update: {
          created_at?: string | null
          display_order?: number | null
          id?: string
          manager_id?: string | null
          name?: string
          organization_id?: string | null
          parent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      derived_recipes: {
        Row: {
          base_dataset_recipe_external_id: string | null
          base_dataset_recipe_id: string
          calcium_mg: number | null
          calories_kcal: number | null
          carbs_g: number | null
          cholesterol_mg: number | null
          created_at: string | null
          created_by_user_id: string | null
          derived_from_menu_set_external_id: string | null
          fat_g: number | null
          fiber_g: number | null
          fiber_insoluble_g: number | null
          fiber_soluble_g: number | null
          folic_acid_ug: number | null
          generation_metadata: Json | null
          generator: string
          id: string
          ingredients: Json
          instructions: string[] | null
          iodine_ug: number | null
          iron_mg: number | null
          magnesium_mg: number | null
          monounsaturated_fat_g: number | null
          name: string
          name_embedding: string | null
          name_norm: string
          phosphorus_mg: number | null
          polyunsaturated_fat_g: number | null
          potassium_mg: number | null
          protein_g: number | null
          saturated_fat_g: number | null
          servings: number
          sodium_g: number | null
          source_dataset_version: string | null
          sugar_g: number | null
          updated_at: string | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_mg: number | null
          vitamin_k_ug: number | null
          zinc_mg: number | null
        }
        Insert: {
          base_dataset_recipe_external_id?: string | null
          base_dataset_recipe_id: string
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          created_by_user_id?: string | null
          derived_from_menu_set_external_id?: string | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          generation_metadata?: Json | null
          generator?: string
          id?: string
          ingredients?: Json
          instructions?: string[] | null
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          monounsaturated_fat_g?: number | null
          name: string
          name_embedding?: string | null
          name_norm: string
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          servings?: number
          sodium_g?: number | null
          source_dataset_version?: string | null
          sugar_g?: number | null
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Update: {
          base_dataset_recipe_external_id?: string | null
          base_dataset_recipe_id?: string
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          created_by_user_id?: string | null
          derived_from_menu_set_external_id?: string | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          generation_metadata?: Json | null
          generator?: string
          id?: string
          ingredients?: Json
          instructions?: string[] | null
          iodine_ug?: number | null
          iron_mg?: number | null
          magnesium_mg?: number | null
          monounsaturated_fat_g?: number | null
          name?: string
          name_embedding?: string | null
          name_norm?: string
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          servings?: number
          sodium_g?: number | null
          source_dataset_version?: string | null
          sugar_g?: number | null
          updated_at?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "derived_recipes_base_dataset_recipe_id_fkey"
            columns: ["base_dataset_recipe_id"]
            isOneToOne: false
            referencedRelation: "dataset_recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      email_blacklist: {
        Row: {
          added_at: string
          added_by: string | null
          email: string
          reason: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          email: string
          reason: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          email?: string
          reason?: string
        }
        Relationships: []
      }
      email_delivery_logs: {
        Row: {
          email: string
          id: string
          metadata: Json | null
          resend_message_id: string | null
          sent_at: string
          status: string
          template: string | null
          user_id: string | null
        }
        Insert: {
          email: string
          id?: string
          metadata?: Json | null
          resend_message_id?: string | null
          sent_at?: string
          status?: string
          template?: string | null
          user_id?: string | null
        }
        Update: {
          email?: string
          id?: string
          metadata?: Json | null
          resend_message_id?: string | null
          sent_at?: string
          status?: string
          template?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      embedding_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          current_offset: number | null
          dimensions: number
          elapsed_minutes: number | null
          error_message: string | null
          id: string
          job_id: string
          metadata: Json | null
          model: string
          percentage: number | null
          start_offset: number | null
          start_time: string | null
          status: string
          table_name: string
          total_count: number | null
          total_processed: number | null
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_offset?: number | null
          dimensions: number
          elapsed_minutes?: number | null
          error_message?: string | null
          id?: string
          job_id: string
          metadata?: Json | null
          model: string
          percentage?: number | null
          start_offset?: number | null
          start_time?: string | null
          status?: string
          table_name: string
          total_count?: number | null
          total_processed?: number | null
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_offset?: number | null
          dimensions?: number
          elapsed_minutes?: number | null
          error_message?: string | null
          id?: string
          job_id?: string
          metadata?: Json | null
          model?: string
          percentage?: number | null
          start_offset?: number | null
          start_time?: string | null
          status?: string
          table_name?: string
          total_count?: number | null
          total_processed?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      experiment_assignments: {
        Row: {
          assigned_at: string
          experiment_id: string
          user_id: string
          variant_key: string
        }
        Insert: {
          assigned_at?: string
          experiment_id: string
          user_id: string
          variant_key: string
        }
        Update: {
          assigned_at?: string
          experiment_id?: string
          user_id?: string
          variant_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "experiment_assignments_experiment_id_fkey"
            columns: ["experiment_id"]
            isOneToOne: false
            referencedRelation: "experiments"
            referencedColumns: ["id"]
          },
        ]
      }
      experiments: {
        Row: {
          created_at: string
          created_by: string
          end_date: string | null
          hypothesis: string | null
          id: string
          key: string
          name: string
          primary_metric: string | null
          result: Json | null
          start_date: string | null
          status: string
          variants: Json
        }
        Insert: {
          created_at?: string
          created_by: string
          end_date?: string | null
          hypothesis?: string | null
          id?: string
          key: string
          name: string
          primary_metric?: string | null
          result?: Json | null
          start_date?: string | null
          status?: string
          variants: Json
        }
        Update: {
          created_at?: string
          created_by?: string
          end_date?: string | null
          hypothesis?: string | null
          id?: string
          key?: string
          name?: string
          primary_metric?: string | null
          result?: Json | null
          start_date?: string | null
          status?: string
          variants?: Json
        }
        Relationships: []
      }
      external_data_consents: {
        Row: {
          consented: boolean
          consented_at: string
          id: string
          ip_address: unknown
          provider: string
          revoked_at: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          consented: boolean
          consented_at?: string
          id?: string
          ip_address?: unknown
          provider: string
          revoked_at?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          consented?: boolean
          consented_at?: string
          id?: string
          ip_address?: unknown
          provider?: string
          revoked_at?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      failed_invite_lookups: {
        Row: {
          attempted_at: string
          id: string
          invite_type: string | null
          ip_address: unknown
          token_hint: string | null
        }
        Insert: {
          attempted_at?: string
          id?: string
          invite_type?: string | null
          ip_address: unknown
          token_hint?: string | null
        }
        Update: {
          attempted_at?: string
          id?: string
          invite_type?: string | null
          ip_address?: unknown
          token_hint?: string | null
        }
        Relationships: []
      }
      family_groups: {
        Row: {
          created_at: string
          dissolved_at: string | null
          id: string
          member_limit: number
          name: string
          plan_key: string
          representative_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          dissolved_at?: string | null
          id?: string
          member_limit?: number
          name: string
          plan_key?: string
          representative_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          dissolved_at?: string | null
          id?: string
          member_limit?: number
          name?: string
          plan_key?: string
          representative_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_groups_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["plan_key"]
          },
        ]
      }
      family_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          custom_message: string | null
          email: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["family_role_enum"]
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          custom_message?: string | null
          email: string
          expires_at: string
          family_id: string
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["family_role_enum"]
          rejected_at?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          custom_message?: string | null
          email?: string
          expires_at?: string
          family_id?: string
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["family_role_enum"]
          rejected_at?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_invites_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      family_meal_logs: {
        Row: {
          completed_at: string | null
          created_at: string | null
          family_member_id: string | null
          id: string
          is_completed: boolean | null
          note: string | null
          planned_meal_id: string | null
          portion_ratio: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          family_member_id?: string | null
          id?: string
          is_completed?: boolean | null
          note?: string | null
          planned_meal_id?: string | null
          portion_ratio?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          family_member_id?: string | null
          id?: string
          is_completed?: boolean | null
          note?: string | null
          planned_meal_id?: string | null
          portion_ratio?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "family_meal_logs_family_member_id_fkey"
            columns: ["family_member_id"]
            isOneToOne: false
            referencedRelation: "legacy_family_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_meal_logs_planned_meal_id_fkey"
            columns: ["planned_meal_id"]
            isOneToOne: false
            referencedRelation: "planned_meals"
            referencedColumns: ["id"]
          },
        ]
      }
      family_members: {
        Row: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        Insert: {
          avatar_color?: string
          child_profile?: Json | null
          display_name?: string | null
          family_id: string
          id?: string
          joined_at?: string
          relationship?: string | null
          removed_at?: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health?: boolean
          share_meals?: boolean
          share_menu?: boolean
          status?: string
          tags?: string[]
          user_id?: string | null
        }
        Update: {
          avatar_color?: string
          child_profile?: Json | null
          display_name?: string | null
          family_id?: string
          id?: string
          joined_at?: string
          relationship?: string | null
          removed_at?: string | null
          role?: Database["public"]["Enums"]["family_role_enum"]
          share_health?: boolean
          share_meals?: boolean
          share_menu?: boolean
          status?: string
          tags?: string[]
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "family_members_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_packages: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          display_order: number
          feature_flags: string[]
          id: string
          package_key: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          display_order?: number
          feature_flags?: string[]
          id?: string
          package_key: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          display_order?: number
          feature_flags?: string[]
          id?: string
          package_key?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      gdpr_deletion_requests: {
        Row: {
          cancelled_at: string | null
          certificate_url: string | null
          cooling_until: string
          executed_at: string | null
          executed_by: string | null
          id: string
          notes: string | null
          requested_at: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          certificate_url?: string | null
          cooling_until?: string
          executed_at?: string | null
          executed_by?: string | null
          id?: string
          notes?: string | null
          requested_at?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          certificate_url?: string | null
          cooling_until?: string
          executed_at?: string | null
          executed_by?: string | null
          id?: string
          notes?: string | null
          requested_at?: string
          user_id?: string
        }
        Relationships: []
      }
      health_challenges: {
        Row: {
          challenge_type: string
          completed_at: string | null
          created_at: string | null
          current_value: number | null
          daily_progress: Json | null
          description: string | null
          end_date: string
          id: string
          reward_badge: string | null
          reward_description: string | null
          reward_points: number | null
          start_date: string
          status: string | null
          target_metric: string
          target_unit: string
          target_value: number
          title: string
          user_id: string
        }
        Insert: {
          challenge_type: string
          completed_at?: string | null
          created_at?: string | null
          current_value?: number | null
          daily_progress?: Json | null
          description?: string | null
          end_date: string
          id?: string
          reward_badge?: string | null
          reward_description?: string | null
          reward_points?: number | null
          start_date: string
          status?: string | null
          target_metric: string
          target_unit: string
          target_value: number
          title: string
          user_id: string
        }
        Update: {
          challenge_type?: string
          completed_at?: string | null
          created_at?: string | null
          current_value?: number | null
          daily_progress?: Json | null
          description?: string | null
          end_date?: string
          id?: string
          reward_badge?: string | null
          reward_description?: string | null
          reward_points?: number | null
          start_date?: string
          status?: string | null
          target_metric?: string
          target_unit?: string
          target_value?: number
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      health_checkup_longitudinal_reviews: {
        Row: {
          checkup_ids: string[]
          created_at: string | null
          id: string
          nutrition_guidance: Json | null
          review_date: string | null
          trend_analysis: Json | null
          user_id: string
        }
        Insert: {
          checkup_ids: string[]
          created_at?: string | null
          id?: string
          nutrition_guidance?: Json | null
          review_date?: string | null
          trend_analysis?: Json | null
          user_id: string
        }
        Update: {
          checkup_ids?: string[]
          created_at?: string | null
          id?: string
          nutrition_guidance?: Json | null
          review_date?: string | null
          trend_analysis?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      health_checkups: {
        Row: {
          alt: number | null
          ast: number | null
          blood_pressure_diastolic: number | null
          blood_pressure_systolic: number | null
          bmi: number | null
          checkup_date: string
          checkup_type: string | null
          created_at: string | null
          creatinine: number | null
          egfr: number | null
          facility_name: string | null
          fasting_glucose: number | null
          gamma_gtp: number | null
          hba1c: number | null
          hdl_cholesterol: number | null
          height: number | null
          hemoglobin: number | null
          id: string
          image_url: string | null
          individual_review: Json | null
          ldl_cholesterol: number | null
          ocr_extracted_data: Json | null
          ocr_extraction_timestamp: string | null
          ocr_model_used: string | null
          total_cholesterol: number | null
          triglycerides: number | null
          updated_at: string | null
          uric_acid: number | null
          user_id: string
          waist_circumference: number | null
          weight: number | null
        }
        Insert: {
          alt?: number | null
          ast?: number | null
          blood_pressure_diastolic?: number | null
          blood_pressure_systolic?: number | null
          bmi?: number | null
          checkup_date: string
          checkup_type?: string | null
          created_at?: string | null
          creatinine?: number | null
          egfr?: number | null
          facility_name?: string | null
          fasting_glucose?: number | null
          gamma_gtp?: number | null
          hba1c?: number | null
          hdl_cholesterol?: number | null
          height?: number | null
          hemoglobin?: number | null
          id?: string
          image_url?: string | null
          individual_review?: Json | null
          ldl_cholesterol?: number | null
          ocr_extracted_data?: Json | null
          ocr_extraction_timestamp?: string | null
          ocr_model_used?: string | null
          total_cholesterol?: number | null
          triglycerides?: number | null
          updated_at?: string | null
          uric_acid?: number | null
          user_id: string
          waist_circumference?: number | null
          weight?: number | null
        }
        Update: {
          alt?: number | null
          ast?: number | null
          blood_pressure_diastolic?: number | null
          blood_pressure_systolic?: number | null
          bmi?: number | null
          checkup_date?: string
          checkup_type?: string | null
          created_at?: string | null
          creatinine?: number | null
          egfr?: number | null
          facility_name?: string | null
          fasting_glucose?: number | null
          gamma_gtp?: number | null
          hba1c?: number | null
          hdl_cholesterol?: number | null
          height?: number | null
          hemoglobin?: number | null
          id?: string
          image_url?: string | null
          individual_review?: Json | null
          ldl_cholesterol?: number | null
          ocr_extracted_data?: Json | null
          ocr_extraction_timestamp?: string | null
          ocr_model_used?: string | null
          total_cholesterol?: number | null
          triglycerides?: number | null
          updated_at?: string | null
          uric_acid?: number | null
          user_id?: string
          waist_circumference?: number | null
          weight?: number | null
        }
        Relationships: []
      }
      health_goals: {
        Row: {
          achieved_at: string | null
          created_at: string | null
          current_value: number | null
          goal_type: string
          id: string
          last_updated_at: string | null
          milestones: Json | null
          note: string | null
          progress_percentage: number | null
          start_date: string | null
          start_value: number | null
          status: string | null
          target_date: string | null
          target_unit: string
          target_value: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          achieved_at?: string | null
          created_at?: string | null
          current_value?: number | null
          goal_type: string
          id?: string
          last_updated_at?: string | null
          milestones?: Json | null
          note?: string | null
          progress_percentage?: number | null
          start_date?: string | null
          start_value?: number | null
          status?: string | null
          target_date?: string | null
          target_unit: string
          target_value: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          achieved_at?: string | null
          created_at?: string | null
          current_value?: number | null
          goal_type?: string
          id?: string
          last_updated_at?: string | null
          milestones?: Json | null
          note?: string | null
          progress_percentage?: number | null
          start_date?: string | null
          start_value?: number | null
          status?: string | null
          target_date?: string | null
          target_unit?: string
          target_value?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      health_insights: {
        Row: {
          analysis_date: string
          applied_to_meal_plan: boolean | null
          confidence_score: number | null
          created_at: string | null
          details: Json | null
          id: string
          insight_type: string
          is_alert: boolean | null
          is_dismissed: boolean | null
          is_read: boolean | null
          period_end: string
          period_start: string
          period_type: string
          priority: string | null
          recommendations: string[] | null
          summary: string
          title: string
          user_id: string
        }
        Insert: {
          analysis_date: string
          applied_to_meal_plan?: boolean | null
          confidence_score?: number | null
          created_at?: string | null
          details?: Json | null
          id?: string
          insight_type: string
          is_alert?: boolean | null
          is_dismissed?: boolean | null
          is_read?: boolean | null
          period_end: string
          period_start: string
          period_type: string
          priority?: string | null
          recommendations?: string[] | null
          summary: string
          title: string
          user_id: string
        }
        Update: {
          analysis_date?: string
          applied_to_meal_plan?: boolean | null
          confidence_score?: number | null
          created_at?: string | null
          details?: Json | null
          id?: string
          insight_type?: string
          is_alert?: boolean | null
          is_dismissed?: boolean | null
          is_read?: boolean | null
          period_end?: string
          period_start?: string
          period_type?: string
          priority?: string | null
          recommendations?: string[] | null
          summary?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      health_records: {
        Row: {
          basal_metabolism: number | null
          bedtime: string | null
          body_fat_percentage: number | null
          body_temp: number | null
          body_water_percentage: number | null
          bone_mass: number | null
          bowel_movement: number | null
          created_at: string | null
          daily_note: string | null
          data_source: string | null
          diastolic_bp: number | null
          energy_level: number | null
          exercise_minutes: number | null
          exercise_type: string[] | null
          fasting_glucose: number | null
          glucose_timing: string | null
          heart_rate: number | null
          hip_circumference: number | null
          id: string
          menstrual_day: number | null
          menstrual_flow: string | null
          mood_score: number | null
          muscle_mass: number | null
          overall_condition: number | null
          pms_symptoms: string[] | null
          postprandial_glucose: number | null
          record_date: string
          recorded_at: string | null
          skin_condition: number | null
          sleep_hours: number | null
          sleep_quality: number | null
          step_count: number | null
          stool_type: number | null
          stress_level: number | null
          swelling: string | null
          symptoms: string[] | null
          systolic_bp: number | null
          tags: string[] | null
          updated_at: string | null
          user_id: string
          visceral_fat_level: number | null
          waist_circumference: number | null
          wake_time: string | null
          water_intake: number | null
          weight: number | null
        }
        Insert: {
          basal_metabolism?: number | null
          bedtime?: string | null
          body_fat_percentage?: number | null
          body_temp?: number | null
          body_water_percentage?: number | null
          bone_mass?: number | null
          bowel_movement?: number | null
          created_at?: string | null
          daily_note?: string | null
          data_source?: string | null
          diastolic_bp?: number | null
          energy_level?: number | null
          exercise_minutes?: number | null
          exercise_type?: string[] | null
          fasting_glucose?: number | null
          glucose_timing?: string | null
          heart_rate?: number | null
          hip_circumference?: number | null
          id?: string
          menstrual_day?: number | null
          menstrual_flow?: string | null
          mood_score?: number | null
          muscle_mass?: number | null
          overall_condition?: number | null
          pms_symptoms?: string[] | null
          postprandial_glucose?: number | null
          record_date: string
          recorded_at?: string | null
          skin_condition?: number | null
          sleep_hours?: number | null
          sleep_quality?: number | null
          step_count?: number | null
          stool_type?: number | null
          stress_level?: number | null
          swelling?: string | null
          symptoms?: string[] | null
          systolic_bp?: number | null
          tags?: string[] | null
          updated_at?: string | null
          user_id: string
          visceral_fat_level?: number | null
          waist_circumference?: number | null
          wake_time?: string | null
          water_intake?: number | null
          weight?: number | null
        }
        Update: {
          basal_metabolism?: number | null
          bedtime?: string | null
          body_fat_percentage?: number | null
          body_temp?: number | null
          body_water_percentage?: number | null
          bone_mass?: number | null
          bowel_movement?: number | null
          created_at?: string | null
          daily_note?: string | null
          data_source?: string | null
          diastolic_bp?: number | null
          energy_level?: number | null
          exercise_minutes?: number | null
          exercise_type?: string[] | null
          fasting_glucose?: number | null
          glucose_timing?: string | null
          heart_rate?: number | null
          hip_circumference?: number | null
          id?: string
          menstrual_day?: number | null
          menstrual_flow?: string | null
          mood_score?: number | null
          muscle_mass?: number | null
          overall_condition?: number | null
          pms_symptoms?: string[] | null
          postprandial_glucose?: number | null
          record_date?: string
          recorded_at?: string | null
          skin_condition?: number | null
          sleep_hours?: number | null
          sleep_quality?: number | null
          step_count?: number | null
          stool_type?: number | null
          stress_level?: number | null
          swelling?: string | null
          symptoms?: string[] | null
          systolic_bp?: number | null
          tags?: string[] | null
          updated_at?: string | null
          user_id?: string
          visceral_fat_level?: number | null
          waist_circumference?: number | null
          wake_time?: string | null
          water_intake?: number | null
          weight?: number | null
        }
        Relationships: []
      }
      health_streaks: {
        Row: {
          achieved_badges: string[] | null
          created_at: string | null
          current_streak: number | null
          id: string
          last_activity_date: string | null
          longest_streak: number | null
          streak_start_date: string | null
          streak_type: string
          total_records: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          achieved_badges?: string[] | null
          created_at?: string | null
          current_streak?: number | null
          id?: string
          last_activity_date?: string | null
          longest_streak?: number | null
          streak_start_date?: string | null
          streak_type: string
          total_records?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          achieved_badges?: string[] | null
          created_at?: string | null
          current_streak?: number | null
          id?: string
          last_activity_date?: string | null
          longest_streak?: number | null
          streak_start_date?: string | null
          streak_type?: string
          total_records?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      help_articles: {
        Row: {
          body: string
          category: string | null
          created_at: string
          created_by: string
          id: string
          locale: string
          slug: string
          status: string
          tags: string[] | null
          title: string
          updated_at: string
          view_count: number
        }
        Insert: {
          body: string
          category?: string | null
          created_at?: string
          created_by: string
          id?: string
          locale?: string
          slug: string
          status?: string
          tags?: string[] | null
          title: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string
          id?: string
          locale?: string
          slug?: string
          status?: string
          tags?: string[] | null
          title?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: []
      }
      infra_alerts: {
        Row: {
          ack_at: string | null
          ack_by: string | null
          comparison: string
          created_at: string
          details: Json | null
          id: string
          metric_name: string
          resolved_at: string | null
          threshold: number
          triggered_at: string
        }
        Insert: {
          ack_at?: string | null
          ack_by?: string | null
          comparison: string
          created_at?: string
          details?: Json | null
          id?: string
          metric_name: string
          resolved_at?: string | null
          threshold: number
          triggered_at: string
        }
        Update: {
          ack_at?: string | null
          ack_by?: string | null
          comparison?: string
          created_at?: string
          details?: Json | null
          id?: string
          metric_name?: string
          resolved_at?: string | null
          threshold?: number
          triggered_at?: string
        }
        Relationships: []
      }
      infra_metrics: {
        Row: {
          id: string
          metric_name: string
          recorded_at: string
          source: string
          tags: Json | null
          unit: string | null
          value: number
        }
        Insert: {
          id?: string
          metric_name: string
          recorded_at?: string
          source: string
          tags?: Json | null
          unit?: string | null
          value: number
        }
        Update: {
          id?: string
          metric_name?: string
          recorded_at?: string
          source?: string
          tags?: Json | null
          unit?: string | null
          value?: number
        }
        Relationships: []
      }
      ingredient_match_cache: {
        Row: {
          created_at: string | null
          id: string
          input_name: string
          match_method: string
          matched_ingredient_id: string | null
          similarity: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          input_name: string
          match_method?: string
          matched_ingredient_id?: string | null
          similarity?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          input_name?: string
          match_method?: string
          matched_ingredient_id?: string | null
          similarity?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ingredient_match_cache_matched_ingredient_id_fkey"
            columns: ["matched_ingredient_id"]
            isOneToOne: false
            referencedRelation: "dataset_ingredients"
            referencedColumns: ["id"]
          },
        ]
      }
      inquiries: {
        Row: {
          admin_notes: string | null
          created_at: string | null
          email: string
          id: string
          inquiry_type: string
          message: string
          resolved_at: string | null
          status: string
          subject: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string | null
          email: string
          id?: string
          inquiry_type: string
          message: string
          resolved_at?: string | null
          status?: string
          subject: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          admin_notes?: string | null
          created_at?: string | null
          email?: string
          id?: string
          inquiry_type?: string
          message?: string
          resolved_at?: string | null
          status?: string
          subject?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      iroca_experiment_plan: {
        Row: {
          drug: string
          hair_type: string
          id: string
          notes: string | null
          phase: string
          purpose: string | null
          ratio: string | null
          recipe_name: string | null
          seq_no: number
          status: string | null
        }
        Insert: {
          drug: string
          hair_type: string
          id: string
          notes?: string | null
          phase: string
          purpose?: string | null
          ratio?: string | null
          recipe_name?: string | null
          seq_no: number
          status?: string | null
        }
        Update: {
          drug?: string
          hair_type?: string
          id?: string
          notes?: string | null
          phase?: string
          purpose?: string | null
          ratio?: string | null
          recipe_name?: string | null
          seq_no?: number
          status?: string | null
        }
        Relationships: []
      }
      iroca_measurements: {
        Row: {
          created_at: string
          delta_e_m0m1: number | null
          device_serial: string | null
          hex_color: string | null
          id: number
          lab_a: number | null
          lab_b: number | null
          lab_l: number | null
          m0_spectrum: number[]
          m1_spectrum: number[] | null
          m2_spectrum: number[] | null
          meas_index: number
          notes: string | null
          raw_xml: string | null
          sample_name: string
          srgb_b: number | null
          srgb_g: number | null
          srgb_r: number | null
        }
        Insert: {
          created_at?: string
          delta_e_m0m1?: number | null
          device_serial?: string | null
          hex_color?: string | null
          id?: number
          lab_a?: number | null
          lab_b?: number | null
          lab_l?: number | null
          m0_spectrum: number[]
          m1_spectrum?: number[] | null
          m2_spectrum?: number[] | null
          meas_index?: number
          notes?: string | null
          raw_xml?: string | null
          sample_name: string
          srgb_b?: number | null
          srgb_g?: number | null
          srgb_r?: number | null
        }
        Update: {
          created_at?: string
          delta_e_m0m1?: number | null
          device_serial?: string | null
          hex_color?: string | null
          id?: number
          lab_a?: number | null
          lab_b?: number | null
          lab_l?: number | null
          m0_spectrum?: number[]
          m1_spectrum?: number[] | null
          m2_spectrum?: number[] | null
          meas_index?: number
          notes?: string | null
          raw_xml?: string | null
          sample_name?: string
          srgb_b?: number | null
          srgb_g?: number | null
          srgb_r?: number | null
        }
        Relationships: []
      }
      iroca_sample_summary: {
        Row: {
          hex_color: string | null
          id: number
          measurement_count: number | null
          median_lab_a: number | null
          median_lab_b: number | null
          median_lab_l: number | null
          median_spectrum: number[] | null
          notes: string | null
          sample_name: string
          srgb_b: number | null
          srgb_g: number | null
          srgb_r: number | null
          updated_at: string
        }
        Insert: {
          hex_color?: string | null
          id?: number
          measurement_count?: number | null
          median_lab_a?: number | null
          median_lab_b?: number | null
          median_lab_l?: number | null
          median_spectrum?: number[] | null
          notes?: string | null
          sample_name: string
          srgb_b?: number | null
          srgb_g?: number | null
          srgb_r?: number | null
          updated_at?: string
        }
        Update: {
          hex_color?: string | null
          id?: number
          measurement_count?: number | null
          median_lab_a?: number | null
          median_lab_b?: number | null
          median_lab_l?: number | null
          median_spectrum?: number[] | null
          notes?: string | null
          sample_name?: string
          srgb_b?: number | null
          srgb_g?: number | null
          srgb_r?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      legacy_family_groups: {
        Row: {
          created_at: string | null
          id: string
          name: string
          owner_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          name?: string
          owner_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
          owner_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      legacy_family_members: {
        Row: {
          allergies: string[] | null
          birth_date: string | null
          created_at: string | null
          daily_calories: number | null
          diet_style: string | null
          dislikes: string[] | null
          display_order: number | null
          family_group_id: string | null
          favorite_foods: string[] | null
          gender: string | null
          health_conditions: string[] | null
          height: number | null
          id: string
          is_active: boolean | null
          name: string
          protein_ratio: number | null
          relation: string
          spice_tolerance: string | null
          updated_at: string | null
          user_id: string | null
          weight: number | null
        }
        Insert: {
          allergies?: string[] | null
          birth_date?: string | null
          created_at?: string | null
          daily_calories?: number | null
          diet_style?: string | null
          dislikes?: string[] | null
          display_order?: number | null
          family_group_id?: string | null
          favorite_foods?: string[] | null
          gender?: string | null
          health_conditions?: string[] | null
          height?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          protein_ratio?: number | null
          relation: string
          spice_tolerance?: string | null
          updated_at?: string | null
          user_id?: string | null
          weight?: number | null
        }
        Update: {
          allergies?: string[] | null
          birth_date?: string | null
          created_at?: string | null
          daily_calories?: number | null
          diet_style?: string | null
          dislikes?: string[] | null
          display_order?: number | null
          family_group_id?: string | null
          favorite_foods?: string[] | null
          gender?: string | null
          health_conditions?: string[] | null
          height?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          protein_ratio?: number | null
          relation?: string
          spice_tolerance?: string | null
          updated_at?: string | null
          user_id?: string | null
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "family_members_family_group_id_fkey"
            columns: ["family_group_id"]
            isOneToOne: false
            referencedRelation: "legacy_family_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_usage_logs: {
        Row: {
          call_type: string | null
          created_at: string | null
          duration_ms: number | null
          endpoint: string
          error_message: string | null
          estimated_cost_usd: number | null
          execution_id: string
          function_name: string
          id: string
          input_tokens: number | null
          is_summary: boolean
          metadata: Json | null
          model: string
          openai_request_id: string | null
          openai_response_id: string | null
          output_tokens: number | null
          provider: string
          request_id: string | null
          status_code: number | null
          success: boolean
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          call_type?: string | null
          created_at?: string | null
          duration_ms?: number | null
          endpoint: string
          error_message?: string | null
          estimated_cost_usd?: number | null
          execution_id: string
          function_name: string
          id?: string
          input_tokens?: number | null
          is_summary?: boolean
          metadata?: Json | null
          model: string
          openai_request_id?: string | null
          openai_response_id?: string | null
          output_tokens?: number | null
          provider?: string
          request_id?: string | null
          status_code?: number | null
          success?: boolean
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          call_type?: string | null
          created_at?: string | null
          duration_ms?: number | null
          endpoint?: string
          error_message?: string | null
          estimated_cost_usd?: number | null
          execution_id?: string
          function_name?: string
          id?: string
          input_tokens?: number | null
          is_summary?: boolean
          metadata?: Json | null
          model?: string
          openai_request_id?: string | null
          openai_response_id?: string | null
          output_tokens?: number | null
          provider?: string
          request_id?: string | null
          status_code?: number | null
          success?: boolean
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      meal_ai_feedbacks: {
        Row: {
          advice_text: string | null
          created_at: string | null
          feedback_text: string
          id: string
          meal_id: string
          model_name: string | null
        }
        Insert: {
          advice_text?: string | null
          created_at?: string | null
          feedback_text: string
          id?: string
          meal_id: string
          model_name?: string | null
        }
        Update: {
          advice_text?: string | null
          created_at?: string | null
          feedback_text?: string
          id?: string
          meal_id?: string
          model_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meal_ai_feedbacks_meal_id_fkey"
            columns: ["meal_id"]
            isOneToOne: false
            referencedRelation: "meals"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_image_jobs: {
        Row: {
          attempt_count: number
          created_at: string
          dish_index: number
          id: string
          idempotency_key: string
          job_kind: string
          last_error: string | null
          lease_token: string | null
          leased_until: string | null
          model: string
          planned_meal_id: string
          priority: number
          prompt: string
          reference_image_urls: Json
          request_id: string | null
          result_image_url: string | null
          status: string
          subject_hash: string
          trigger_source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          dish_index: number
          id?: string
          idempotency_key: string
          job_kind?: string
          last_error?: string | null
          lease_token?: string | null
          leased_until?: string | null
          model: string
          planned_meal_id: string
          priority?: number
          prompt: string
          reference_image_urls?: Json
          request_id?: string | null
          result_image_url?: string | null
          status?: string
          subject_hash: string
          trigger_source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          dish_index?: number
          id?: string
          idempotency_key?: string
          job_kind?: string
          last_error?: string | null
          lease_token?: string | null
          leased_until?: string | null
          model?: string
          planned_meal_id?: string
          priority?: number
          prompt?: string
          reference_image_urls?: Json
          request_id?: string | null
          result_image_url?: string | null
          status?: string
          subject_hash?: string
          trigger_source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_image_jobs_planned_meal_id_fkey"
            columns: ["planned_meal_id"]
            isOneToOne: false
            referencedRelation: "planned_meals"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_nutrition_debug_logs: {
        Row: {
          calculated_nutrition: Json
          created_at: string
          daily_meal_id: string | null
          dish_name: string
          dish_role: string | null
          dish_timing_ms: Json
          final_nutrition: Json
          id: string
          ingredient_matches: Json
          input_ingredients: Json
          issue_flags: string[]
          meal_type: string
          metadata: Json
          normalized_ingredients: Json
          planned_meal_id: string | null
          request_id: string | null
          slot_timing_ms: Json
          source_function: string
          source_kind: string
          target_date: string
          user_id: string | null
          validation_result: Json
        }
        Insert: {
          calculated_nutrition?: Json
          created_at?: string
          daily_meal_id?: string | null
          dish_name: string
          dish_role?: string | null
          dish_timing_ms?: Json
          final_nutrition?: Json
          id?: string
          ingredient_matches?: Json
          input_ingredients?: Json
          issue_flags?: string[]
          meal_type: string
          metadata?: Json
          normalized_ingredients?: Json
          planned_meal_id?: string | null
          request_id?: string | null
          slot_timing_ms?: Json
          source_function?: string
          source_kind?: string
          target_date: string
          user_id?: string | null
          validation_result?: Json
        }
        Update: {
          calculated_nutrition?: Json
          created_at?: string
          daily_meal_id?: string | null
          dish_name?: string
          dish_role?: string | null
          dish_timing_ms?: Json
          final_nutrition?: Json
          id?: string
          ingredient_matches?: Json
          input_ingredients?: Json
          issue_flags?: string[]
          meal_type?: string
          metadata?: Json
          normalized_ingredients?: Json
          planned_meal_id?: string | null
          request_id?: string | null
          slot_timing_ms?: Json
          source_function?: string
          source_kind?: string
          target_date?: string
          user_id?: string | null
          validation_result?: Json
        }
        Relationships: [
          {
            foreignKeyName: "meal_nutrition_debug_logs_daily_meal_id_fkey"
            columns: ["daily_meal_id"]
            isOneToOne: false
            referencedRelation: "user_daily_meals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_nutrition_debug_logs_planned_meal_id_fkey"
            columns: ["planned_meal_id"]
            isOneToOne: false
            referencedRelation: "planned_meals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_nutrition_debug_logs_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "weekly_menu_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_nutrition_estimates: {
        Row: {
          carbs_g: number | null
          created_at: string | null
          energy_kcal: number | null
          fat_g: number | null
          id: string
          meal_id: string
          protein_g: number | null
          quality_tags: string[] | null
          raw_json: Json | null
          veg_score: number | null
        }
        Insert: {
          carbs_g?: number | null
          created_at?: string | null
          energy_kcal?: number | null
          fat_g?: number | null
          id?: string
          meal_id: string
          protein_g?: number | null
          quality_tags?: string[] | null
          raw_json?: Json | null
          veg_score?: number | null
        }
        Update: {
          carbs_g?: number | null
          created_at?: string | null
          energy_kcal?: number | null
          fat_g?: number | null
          id?: string
          meal_id?: string
          protein_g?: number | null
          quality_tags?: string[] | null
          raw_json?: Json | null
          veg_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "meal_nutrition_estimates_meal_id_fkey"
            columns: ["meal_id"]
            isOneToOne: false
            referencedRelation: "meals"
            referencedColumns: ["id"]
          },
        ]
      }
      meals: {
        Row: {
          created_at: string | null
          eaten_at: string
          id: string
          is_sandbox: boolean
          meal_type: string
          memo: string | null
          paste_group_id: string | null
          photo_url: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          eaten_at: string
          id?: string
          is_sandbox?: boolean
          meal_type: string
          memo?: string | null
          paste_group_id?: string | null
          photo_url?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          eaten_at?: string
          id?: string
          is_sandbox?: boolean
          meal_type?: string
          memo?: string | null
          paste_group_id?: string | null
          photo_url?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      membership_audit: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json
          scope: string
          scope_id: string
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          scope: string
          scope_id: string
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          scope?: string
          scope_id?: string
          target_user_id?: string | null
        }
        Relationships: []
      }
      metric_definitions: {
        Row: {
          category: string
          code: string
          created_at: string | null
          description: string | null
          higher_is_better: boolean | null
          id: string
          is_active: boolean | null
          name: string
          unit: string | null
        }
        Insert: {
          category: string
          code: string
          created_at?: string | null
          description?: string | null
          higher_is_better?: boolean | null
          id?: string
          is_active?: boolean | null
          name: string
          unit?: string | null
        }
        Update: {
          category?: string
          code?: string
          created_at?: string | null
          description?: string | null
          higher_is_better?: boolean | null
          id?: string
          is_active?: boolean | null
          name?: string
          unit?: string | null
        }
        Relationships: []
      }
      moderation_flags: {
        Row: {
          created_at: string | null
          flag_type: string | null
          id: string
          meal_id: string | null
          reason: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          flag_type?: string | null
          id?: string
          meal_id?: string | null
          reason?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          flag_type?: string | null
          id?: string
          meal_id?: string | null
          reason?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "moderation_flags_meal_id_fkey"
            columns: ["meal_id"]
            isOneToOne: false
            referencedRelation: "meals"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          auto_analyze_enabled: boolean
          consecutive_ignores: number | null
          created_at: string | null
          data_share_enabled: boolean
          enabled: boolean | null
          evening_reminder_enabled: boolean | null
          evening_reminder_time: string | null
          id: string
          last_notification_at: string | null
          morning_reminder_enabled: boolean | null
          morning_reminder_time: string | null
          notifications_enabled: boolean
          optimal_evening_time: string | null
          optimal_morning_time: string | null
          personality_type: string | null
          quiet_hours_end: string | null
          quiet_hours_start: string | null
          record_mode: string | null
          response_rate_by_hour: Json | null
          total_notifications_opened: number | null
          total_notifications_sent: number | null
          updated_at: string | null
          user_id: string
          vacation_mode: boolean | null
          vacation_until: string | null
        }
        Insert: {
          auto_analyze_enabled?: boolean
          consecutive_ignores?: number | null
          created_at?: string | null
          data_share_enabled?: boolean
          enabled?: boolean | null
          evening_reminder_enabled?: boolean | null
          evening_reminder_time?: string | null
          id?: string
          last_notification_at?: string | null
          morning_reminder_enabled?: boolean | null
          morning_reminder_time?: string | null
          notifications_enabled?: boolean
          optimal_evening_time?: string | null
          optimal_morning_time?: string | null
          personality_type?: string | null
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          record_mode?: string | null
          response_rate_by_hour?: Json | null
          total_notifications_opened?: number | null
          total_notifications_sent?: number | null
          updated_at?: string | null
          user_id: string
          vacation_mode?: boolean | null
          vacation_until?: string | null
        }
        Update: {
          auto_analyze_enabled?: boolean
          consecutive_ignores?: number | null
          created_at?: string | null
          data_share_enabled?: boolean
          enabled?: boolean | null
          evening_reminder_enabled?: boolean | null
          evening_reminder_time?: string | null
          id?: string
          last_notification_at?: string | null
          morning_reminder_enabled?: boolean | null
          morning_reminder_time?: string | null
          notifications_enabled?: boolean
          optimal_evening_time?: string | null
          optimal_morning_time?: string | null
          personality_type?: string | null
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          record_mode?: string | null
          response_rate_by_hour?: Json | null
          total_notifications_opened?: number | null
          total_notifications_sent?: number | null
          updated_at?: string | null
          user_id?: string
          vacation_mode?: boolean | null
          vacation_until?: string | null
        }
        Relationships: []
      }
      nps_surveys: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          plan_key: string | null
          responded_at: string | null
          score: number
          sent_at: string
          user_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          plan_key?: string | null
          responded_at?: string | null
          score: number
          sent_at: string
          user_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          plan_key?: string | null
          responded_at?: string | null
          score?: number
          sent_at?: string
          user_id?: string
        }
        Relationships: []
      }
      nutrition_feedback_cache: {
        Row: {
          created_at: string | null
          feedback: string
          id: string
          nutrition_hash: string
          status: string | null
          target_date: string
          updated_at: string | null
          user_id: string
          week_hash: string | null
        }
        Insert: {
          created_at?: string | null
          feedback: string
          id?: string
          nutrition_hash: string
          status?: string | null
          target_date: string
          updated_at?: string | null
          user_id: string
          week_hash?: string | null
        }
        Update: {
          created_at?: string | null
          feedback?: string
          id?: string
          nutrition_hash?: string
          status?: string | null
          target_date?: string
          updated_at?: string | null
          user_id?: string
          week_hash?: string | null
        }
        Relationships: []
      }
      nutrition_targets: {
        Row: {
          auto_calculate: boolean | null
          calcium_mg: number | null
          calculation_basis: Json | null
          carbs_g: number | null
          cholesterol_mg: number | null
          created_at: string | null
          daily_calories: number | null
          fat_g: number | null
          fiber_g: number | null
          fiber_insoluble_g: number | null
          fiber_soluble_g: number | null
          folic_acid_ug: number | null
          id: string
          iodine_ug: number | null
          iron_mg: number | null
          last_calculated_at: string | null
          monounsaturated_fat_g: number | null
          phosphorus_mg: number | null
          polyunsaturated_fat_g: number | null
          potassium_mg: number | null
          protein_g: number | null
          saturated_fat_g: number | null
          sodium_g: number | null
          sugar_g: number | null
          updated_at: string | null
          user_id: string | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_mg: number | null
          vitamin_k_ug: number | null
          zinc_mg: number | null
        }
        Insert: {
          auto_calculate?: boolean | null
          calcium_mg?: number | null
          calculation_basis?: Json | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          daily_calories?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          last_calculated_at?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          sugar_g?: number | null
          updated_at?: string | null
          user_id?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Update: {
          auto_calculate?: boolean | null
          calcium_mg?: number | null
          calculation_basis?: Json | null
          carbs_g?: number | null
          cholesterol_mg?: number | null
          created_at?: string | null
          daily_calories?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          id?: string
          iodine_ug?: number | null
          iron_mg?: number | null
          last_calculated_at?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          sugar_g?: number | null
          updated_at?: string | null
          user_id?: string | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Relationships: []
      }
      org_daily_stats: {
        Row: {
          active_member_count: number | null
          avg_score: number | null
          breakfast_rate: number | null
          created_at: string | null
          date: string
          id: string
          late_night_rate: number | null
          member_count: number | null
          organization_id: string | null
          updated_at: string | null
        }
        Insert: {
          active_member_count?: number | null
          avg_score?: number | null
          breakfast_rate?: number | null
          created_at?: string | null
          date: string
          id?: string
          late_night_rate?: number | null
          member_count?: number | null
          organization_id?: string | null
          updated_at?: string | null
        }
        Update: {
          active_member_count?: number | null
          avg_score?: number | null
          breakfast_rate?: number | null
          created_at?: string | null
          date?: string
          id?: string
          late_night_rate?: number | null
          member_count?: number | null
          organization_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_daily_stats_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_license_pools: {
        Row: {
          available_licenses: number | null
          family_addon_seats: number
          organization_id: string
          total_licenses: number | null
          updated_at: string
          used_licenses: number
        }
        Insert: {
          available_licenses?: number | null
          family_addon_seats?: number
          organization_id: string
          total_licenses?: number | null
          updated_at?: string
          used_licenses?: number
        }
        Update: {
          available_licenses?: number | null
          family_addon_seats?: number
          organization_id?: string
          total_licenses?: number | null
          updated_at?: string
          used_licenses?: number
        }
        Relationships: [
          {
            foreignKeyName: "org_license_pools_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_challenge_participants: {
        Row: {
          challenge_id: string | null
          current_value: number | null
          id: string
          joined_at: string | null
          rank: number | null
          user_id: string | null
        }
        Insert: {
          challenge_id?: string | null
          current_value?: number | null
          id?: string
          joined_at?: string | null
          rank?: number | null
          user_id?: string | null
        }
        Update: {
          challenge_id?: string | null
          current_value?: number | null
          id?: string
          joined_at?: string | null
          rank?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_challenge_participants_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "organization_challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_challenges: {
        Row: {
          challenge_type: string
          created_at: string | null
          created_by: string | null
          department_id: string | null
          description: string | null
          end_date: string
          id: string
          organization_id: string | null
          reward_description: string | null
          start_date: string
          status: string | null
          target_unit: string | null
          target_value: number | null
          title: string
        }
        Insert: {
          challenge_type: string
          created_at?: string | null
          created_by?: string | null
          department_id?: string | null
          description?: string | null
          end_date: string
          id?: string
          organization_id?: string | null
          reward_description?: string | null
          start_date: string
          status?: string | null
          target_unit?: string | null
          target_value?: number | null
          title: string
        }
        Update: {
          challenge_type?: string
          created_at?: string | null
          created_by?: string | null
          department_id?: string | null
          description?: string | null
          end_date?: string
          id?: string
          organization_id?: string | null
          reward_description?: string | null
          start_date?: string
          status?: string | null
          target_unit?: string | null
          target_value?: number | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_challenges_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_challenges_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string | null
          created_by: string | null
          custom_message: string | null
          department_id: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["org_role_enum"]
          organization_id: string | null
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: string | null
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string | null
          created_by?: string | null
          custom_message?: string | null
          department_id?: string | null
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["org_role_enum"]
          organization_id?: string | null
          rejected_at?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: string | null
          status?: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string | null
          created_by?: string | null
          custom_message?: string | null
          department_id?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          invited_role?: Database["public"]["Enums"]["org_role_enum"]
          organization_id?: string | null
          rejected_at?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: string | null
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invites_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_reports: {
        Row: {
          created_at: string | null
          data: Json
          generated_by: string | null
          id: string
          insights: string[] | null
          organization_id: string | null
          period_end: string
          period_start: string
          report_type: string
        }
        Insert: {
          created_at?: string | null
          data: Json
          generated_by?: string | null
          id?: string
          insights?: string[] | null
          organization_id?: string | null
          period_end: string
          period_start: string
          report_type: string
        }
        Update: {
          created_at?: string | null
          data?: Json
          generated_by?: string | null
          id?: string
          insights?: string[] | null
          organization_id?: string | null
          period_end?: string
          period_start?: string
          report_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          created_at: string | null
          dissolved_at: string | null
          employee_count: number | null
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          owner_id: string | null
          plan: string | null
          settings: Json | null
          status: string
          subscription_expires_at: string | null
          subscription_status: string | null
          updated_at: string | null
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          created_at?: string | null
          dissolved_at?: string | null
          employee_count?: number | null
          id?: string
          industry?: string | null
          logo_url?: string | null
          name: string
          owner_id?: string | null
          plan?: string | null
          settings?: Json | null
          status?: string
          subscription_expires_at?: string | null
          subscription_status?: string | null
          updated_at?: string | null
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          created_at?: string | null
          dissolved_at?: string | null
          employee_count?: number | null
          id?: string
          industry?: string | null
          logo_url?: string | null
          name?: string
          owner_id?: string | null
          plan?: string | null
          settings?: Json | null
          status?: string
          subscription_expires_at?: string | null
          subscription_status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ownership_transfer_proposals: {
        Row: {
          expires_at: string
          from_user_id: string
          id: string
          proposed_at: string
          resolved_at: string | null
          scope: string
          scope_id: string
          status: string
          to_user_id: string
        }
        Insert: {
          expires_at?: string
          from_user_id: string
          id?: string
          proposed_at?: string
          resolved_at?: string | null
          scope: string
          scope_id: string
          status?: string
          to_user_id: string
        }
        Update: {
          expires_at?: string
          from_user_id?: string
          id?: string
          proposed_at?: string
          resolved_at?: string | null
          scope?: string
          scope_id?: string
          status?: string
          to_user_id?: string
        }
        Relationships: []
      }
      pantry_items: {
        Row: {
          added_at: string | null
          amount: string | null
          category: string
          created_at: string | null
          expiration_date: string | null
          id: string
          name: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          added_at?: string | null
          amount?: string | null
          category?: string
          created_at?: string | null
          expiration_date?: string | null
          id?: string
          name: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          added_at?: string | null
          amount?: string | null
          category?: string
          created_at?: string | null
          expiration_date?: string | null
          id?: string
          name?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      password_history: {
        Row: {
          changed_at: string
          password_hash: string
          user_id: string
        }
        Insert: {
          changed_at?: string
          password_hash: string
          user_id: string
        }
        Update: {
          changed_at?: string
          password_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      performance_plans: {
        Row: {
          adjustment_type: string
          adjustment_value: Json
          created_at: string | null
          end_date: string | null
          evidence_urls: string[] | null
          id: string
          rationale: string
          start_date: string
          status: string
          trigger_data: Json | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          adjustment_type: string
          adjustment_value: Json
          created_at?: string | null
          end_date?: string | null
          evidence_urls?: string[] | null
          id?: string
          rationale: string
          start_date: string
          status?: string
          trigger_data?: Json | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          adjustment_type?: string
          adjustment_value?: Json
          created_at?: string | null
          end_date?: string | null
          evidence_urls?: string[] | null
          id?: string
          rationale?: string
          start_date?: string
          status?: string
          trigger_data?: Json | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      personal_subscriptions: {
        Row: {
          active_coupon_redemption_id: string | null
          cancel_at: string | null
          cancelled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          grace_started_at: string | null
          id: string
          notes: string | null
          past_due_since: string | null
          pause_reason: string | null
          paused_at: string | null
          paused_until: string | null
          plan_key: string
          starts_at: string
          status: string
          stripe_customer_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          trial_ends_at: string | null
          trial_source: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active_coupon_redemption_id?: string | null
          cancel_at?: string | null
          cancelled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_started_at?: string | null
          id?: string
          notes?: string | null
          past_due_since?: string | null
          pause_reason?: string | null
          paused_at?: string | null
          paused_until?: string | null
          plan_key: string
          starts_at?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          trial_source?: string | null
          trial_started_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active_coupon_redemption_id?: string | null
          cancel_at?: string | null
          cancelled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_started_at?: string | null
          id?: string
          notes?: string | null
          past_due_since?: string | null
          pause_reason?: string | null
          paused_at?: string | null
          paused_until?: string | null
          plan_key?: string
          starts_at?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          trial_source?: string | null
          trial_started_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_subscriptions_active_coupon_redemption_id_fkey"
            columns: ["active_coupon_redemption_id"]
            isOneToOne: false
            referencedRelation: "coupon_redemptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_subscriptions_plan_key_fkey"
            columns: ["plan_key"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["plan_key"]
          },
        ]
      }
      plan_price_history: {
        Row: {
          affected_subscription_count: number | null
          applies_to: string
          changed_by: string
          created_at: string
          effective_at: string
          id: string
          new_monthly_price_jpy: number | null
          new_stripe_price_id: string | null
          new_yearly_price_jpy: number | null
          old_monthly_price_jpy: number | null
          old_stripe_price_id: string | null
          old_yearly_price_jpy: number | null
          plan_id: string
          reason: string | null
        }
        Insert: {
          affected_subscription_count?: number | null
          applies_to: string
          changed_by: string
          created_at?: string
          effective_at: string
          id?: string
          new_monthly_price_jpy?: number | null
          new_stripe_price_id?: string | null
          new_yearly_price_jpy?: number | null
          old_monthly_price_jpy?: number | null
          old_stripe_price_id?: string | null
          old_yearly_price_jpy?: number | null
          plan_id: string
          reason?: string | null
        }
        Update: {
          affected_subscription_count?: number | null
          applies_to?: string
          changed_by?: string
          created_at?: string
          effective_at?: string
          id?: string
          new_monthly_price_jpy?: number | null
          new_stripe_price_id?: string | null
          new_yearly_price_jpy?: number | null
          old_monthly_price_jpy?: number | null
          old_stripe_price_id?: string | null
          old_yearly_price_jpy?: number | null
          plan_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_price_history_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      planned_meals: {
        Row: {
          actual_meal_id: string | null
          amino_acid_g: number | null
          calcium_mg: number | null
          calories_kcal: number | null
          carbs_g: number | null
          catalog_product_id: string | null
          cholesterol_mg: number | null
          completed_at: string | null
          cooking_time_minutes: number | null
          created_at: string | null
          daily_meal_id: string | null
          description: string | null
          dish_name: string
          dishes: Json | null
          display_order: number | null
          fat_g: number | null
          fiber_g: number | null
          fiber_insoluble_g: number | null
          fiber_soluble_g: number | null
          folic_acid_ug: number | null
          generation_metadata: Json | null
          id: string
          image_url: string | null
          ingredients: string[] | null
          iodine_ug: number | null
          iron_mg: number | null
          is_completed: boolean | null
          is_generating: boolean | null
          is_simple: boolean | null
          magnesium_mg: number | null
          meal_type: string
          memo: string | null
          mode: string | null
          monounsaturated_fat_g: number | null
          phosphorus_mg: number | null
          polyunsaturated_fat_g: number | null
          potassium_mg: number | null
          protein_g: number | null
          quality_tags: string[] | null
          recipe_steps: string[] | null
          recipe_url: string | null
          saturated_fat_g: number | null
          sodium_g: number | null
          source_dataset_version: string | null
          source_menu_set_external_id: string | null
          source_type: string
          sugar_g: number | null
          updated_at: string | null
          veg_score: number | null
          vitamin_a_ug: number | null
          vitamin_b1_mg: number | null
          vitamin_b12_ug: number | null
          vitamin_b2_mg: number | null
          vitamin_b6_mg: number | null
          vitamin_c_mg: number | null
          vitamin_d_ug: number | null
          vitamin_e_mg: number | null
          vitamin_k_ug: number | null
          zinc_mg: number | null
        }
        Insert: {
          actual_meal_id?: string | null
          amino_acid_g?: number | null
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          catalog_product_id?: string | null
          cholesterol_mg?: number | null
          completed_at?: string | null
          cooking_time_minutes?: number | null
          created_at?: string | null
          daily_meal_id?: string | null
          description?: string | null
          dish_name: string
          dishes?: Json | null
          display_order?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          generation_metadata?: Json | null
          id?: string
          image_url?: string | null
          ingredients?: string[] | null
          iodine_ug?: number | null
          iron_mg?: number | null
          is_completed?: boolean | null
          is_generating?: boolean | null
          is_simple?: boolean | null
          magnesium_mg?: number | null
          meal_type: string
          memo?: string | null
          mode?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          quality_tags?: string[] | null
          recipe_steps?: string[] | null
          recipe_url?: string | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_dataset_version?: string | null
          source_menu_set_external_id?: string | null
          source_type?: string
          sugar_g?: number | null
          updated_at?: string | null
          veg_score?: number | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Update: {
          actual_meal_id?: string | null
          amino_acid_g?: number | null
          calcium_mg?: number | null
          calories_kcal?: number | null
          carbs_g?: number | null
          catalog_product_id?: string | null
          cholesterol_mg?: number | null
          completed_at?: string | null
          cooking_time_minutes?: number | null
          created_at?: string | null
          daily_meal_id?: string | null
          description?: string | null
          dish_name?: string
          dishes?: Json | null
          display_order?: number | null
          fat_g?: number | null
          fiber_g?: number | null
          fiber_insoluble_g?: number | null
          fiber_soluble_g?: number | null
          folic_acid_ug?: number | null
          generation_metadata?: Json | null
          id?: string
          image_url?: string | null
          ingredients?: string[] | null
          iodine_ug?: number | null
          iron_mg?: number | null
          is_completed?: boolean | null
          is_generating?: boolean | null
          is_simple?: boolean | null
          magnesium_mg?: number | null
          meal_type?: string
          memo?: string | null
          mode?: string | null
          monounsaturated_fat_g?: number | null
          phosphorus_mg?: number | null
          polyunsaturated_fat_g?: number | null
          potassium_mg?: number | null
          protein_g?: number | null
          quality_tags?: string[] | null
          recipe_steps?: string[] | null
          recipe_url?: string | null
          saturated_fat_g?: number | null
          sodium_g?: number | null
          source_dataset_version?: string | null
          source_menu_set_external_id?: string | null
          source_type?: string
          sugar_g?: number | null
          updated_at?: string | null
          veg_score?: number | null
          vitamin_a_ug?: number | null
          vitamin_b1_mg?: number | null
          vitamin_b12_ug?: number | null
          vitamin_b2_mg?: number | null
          vitamin_b6_mg?: number | null
          vitamin_c_mg?: number | null
          vitamin_d_ug?: number | null
          vitamin_e_mg?: number | null
          vitamin_k_ug?: number | null
          zinc_mg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "planned_meals_actual_meal_id_fkey"
            columns: ["actual_meal_id"]
            isOneToOne: false
            referencedRelation: "meals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planned_meals_catalog_product_id_fkey"
            columns: ["catalog_product_id"]
            isOneToOne: false
            referencedRelation: "catalog_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planned_meals_daily_meal_id_fkey"
            columns: ["daily_meal_id"]
            isOneToOne: false
            referencedRelation: "user_daily_meals"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_collection_items: {
        Row: {
          added_at: string | null
          collection_id: string
          recipe_id: string
        }
        Insert: {
          added_at?: string | null
          collection_id: string
          recipe_id: string
        }
        Update: {
          added_at?: string | null
          collection_id?: string
          recipe_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_collection_items_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_collection_items_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_collections: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_public: boolean | null
          name: string
          recipe_ids: string[] | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean | null
          name: string
          recipe_ids?: string[] | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean | null
          name?: string
          recipe_ids?: string[] | null
          user_id?: string | null
        }
        Relationships: []
      }
      recipe_comments: {
        Row: {
          content: string
          created_at: string | null
          id: string
          rating: number | null
          recipe_id: string | null
          user_id: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          rating?: number | null
          recipe_id?: string | null
          user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          rating?: number | null
          recipe_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_comments_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_flags: {
        Row: {
          created_at: string | null
          flag_type: string
          id: string
          reason: string | null
          recipe_id: string | null
          reporter_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          flag_type?: string
          id?: string
          reason?: string | null
          recipe_id?: string | null
          reporter_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          flag_type?: string
          id?: string
          reason?: string | null
          recipe_id?: string | null
          reporter_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_flags_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_likes: {
        Row: {
          created_at: string | null
          id: string
          recipe_id: string
          recipe_uuid: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          recipe_id: string
          recipe_uuid?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          recipe_id?: string
          recipe_uuid?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_likes_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_likes_recipe_uuid_fkey"
            columns: ["recipe_uuid"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_requests: {
        Row: {
          base_meal_id: string | null
          created_at: string | null
          error_message: string | null
          id: string
          prompt: string | null
          result_text: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          base_meal_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          prompt?: string | null
          result_text?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          base_meal_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          prompt?: string | null
          result_text?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_requests_base_meal_id_fkey"
            columns: ["base_meal_id"]
            isOneToOne: false
            referencedRelation: "meals"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          calories_kcal: number | null
          category: string | null
          cooking_time_minutes: number | null
          created_at: string | null
          cuisine_type: string | null
          description: string | null
          difficulty: string | null
          id: string
          image_url: string | null
          ingredients: Json | null
          is_public: boolean | null
          like_count: number | null
          name: string
          nutrition: Json | null
          servings: number | null
          source_url: string | null
          steps: string[] | null
          tags: string[] | null
          tips: string | null
          updated_at: string | null
          user_id: string | null
          video_url: string | null
          view_count: number | null
        }
        Insert: {
          calories_kcal?: number | null
          category?: string | null
          cooking_time_minutes?: number | null
          created_at?: string | null
          cuisine_type?: string | null
          description?: string | null
          difficulty?: string | null
          id?: string
          image_url?: string | null
          ingredients?: Json | null
          is_public?: boolean | null
          like_count?: number | null
          name: string
          nutrition?: Json | null
          servings?: number | null
          source_url?: string | null
          steps?: string[] | null
          tags?: string[] | null
          tips?: string | null
          updated_at?: string | null
          user_id?: string | null
          video_url?: string | null
          view_count?: number | null
        }
        Update: {
          calories_kcal?: number | null
          category?: string | null
          cooking_time_minutes?: number | null
          created_at?: string | null
          cuisine_type?: string | null
          description?: string | null
          difficulty?: string | null
          id?: string
          image_url?: string | null
          ingredients?: Json | null
          is_public?: boolean | null
          like_count?: number | null
          name?: string
          nutrition?: Json | null
          servings?: number | null
          source_url?: string | null
          steps?: string[] | null
          tags?: string[] | null
          tips?: string | null
          updated_at?: string | null
          user_id?: string | null
          video_url?: string | null
          view_count?: number | null
        }
        Relationships: []
      }
      referral_rewards: {
        Row: {
          created_at: string
          expires_at: string | null
          granted_at: string | null
          id: string
          referred_id: string
          referrer_id: string
          reward_type: string
          reward_value: Json
          status: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          referred_id: string
          referrer_id: string
          reward_type: string
          reward_value: Json
          status?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          granted_at?: string | null
          id?: string
          referred_id?: string
          referrer_id?: string
          reward_type?: string
          reward_value?: Json
          status?: string
        }
        Relationships: []
      }
      revenue_snapshots: {
        Row: {
          cancellations: number
          computed_at: string
          date: string
          downgrade_count: number
          family_active_groups: number
          family_mrr_jpy: number
          new_signups: number
          org_active_orgs: number
          org_active_seats: number
          org_mrr_jpy: number
          personal_active_users: number
          personal_mrr_jpy: number
          total_arr_jpy: number
          total_mrr_jpy: number
          trial_conversions: number
          trial_starts: number
          upgrade_count: number
        }
        Insert: {
          cancellations?: number
          computed_at?: string
          date: string
          downgrade_count?: number
          family_active_groups?: number
          family_mrr_jpy?: number
          new_signups?: number
          org_active_orgs?: number
          org_active_seats?: number
          org_mrr_jpy?: number
          personal_active_users?: number
          personal_mrr_jpy?: number
          total_arr_jpy?: number
          total_mrr_jpy?: number
          trial_conversions?: number
          trial_starts?: number
          upgrade_count?: number
        }
        Update: {
          cancellations?: number
          computed_at?: string
          date?: string
          downgrade_count?: number
          family_active_groups?: number
          family_mrr_jpy?: number
          new_signups?: number
          org_active_orgs?: number
          org_active_seats?: number
          org_mrr_jpy?: number
          personal_active_users?: number
          personal_mrr_jpy?: number
          total_arr_jpy?: number
          total_mrr_jpy?: number
          trial_conversions?: number
          trial_starts?: number
          upgrade_count?: number
        }
        Relationships: []
      }
      sales_lead_activities: {
        Row: {
          activity_type: string
          actor_id: string
          created_at: string
          details: Json
          id: string
          lead_id: string
        }
        Insert: {
          activity_type: string
          actor_id: string
          created_at?: string
          details: Json
          id?: string
          lead_id: string
        }
        Update: {
          activity_type?: string
          actor_id?: string
          created_at?: string
          details?: Json
          id?: string
          lead_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "sales_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_leads: {
        Row: {
          assigned_to: string | null
          company_name: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          converted_org_id: string | null
          created_at: string
          employee_count: number | null
          estimated_acv: number | null
          id: string
          industry: string | null
          notes: string | null
          source: string | null
          stage: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          company_name: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          converted_org_id?: string | null
          created_at?: string
          employee_count?: number | null
          estimated_acv?: number | null
          id?: string
          industry?: string | null
          notes?: string | null
          source?: string | null
          stage?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          company_name?: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          converted_org_id?: string | null
          created_at?: string
          employee_count?: number | null
          estimated_acv?: number | null
          id?: string
          industry?: string | null
          notes?: string | null
          source?: string | null
          stage?: string
          updated_at?: string
        }
        Relationships: []
      }
      segment_definitions: {
        Row: {
          axes: Json
          code: string
          created_at: string | null
          id: string
          is_active: boolean | null
          level: number
          name: string
        }
        Insert: {
          axes: Json
          code: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          level?: number
          name: string
        }
        Update: {
          axes?: Json
          code?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          level?: number
          name?: string
        }
        Relationships: []
      }
      segment_stats: {
        Row: {
          avg_value: number | null
          id: string
          max_value: number | null
          median_value: number | null
          metric_id: string | null
          min_value: number | null
          p10_value: number | null
          p25_value: number | null
          p75_value: number | null
          p90_value: number | null
          period_end: string
          period_start: string
          period_type: string
          segment_id: string | null
          updated_at: string | null
          user_count: number
        }
        Insert: {
          avg_value?: number | null
          id?: string
          max_value?: number | null
          median_value?: number | null
          metric_id?: string | null
          min_value?: number | null
          p10_value?: number | null
          p25_value?: number | null
          p75_value?: number | null
          p90_value?: number | null
          period_end: string
          period_start: string
          period_type: string
          segment_id?: string | null
          updated_at?: string | null
          user_count?: number
        }
        Update: {
          avg_value?: number | null
          id?: string
          max_value?: number | null
          median_value?: number | null
          metric_id?: string | null
          min_value?: number | null
          p10_value?: number | null
          p25_value?: number | null
          p75_value?: number | null
          p90_value?: number | null
          period_end?: string
          period_start?: string
          period_type?: string
          segment_id?: string | null
          updated_at?: string | null
          user_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "segment_stats_metric_id_fkey"
            columns: ["metric_id"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segment_stats_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segment_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      shopping_list_items: {
        Row: {
          category: string
          created_at: string | null
          id: string
          is_checked: boolean | null
          item_name: string
          normalized_name: string | null
          quantity: string | null
          quantity_variants: Json | null
          selected_variant_index: number | null
          shopping_list_id: string | null
          source: string
          updated_at: string | null
        }
        Insert: {
          category?: string
          created_at?: string | null
          id?: string
          is_checked?: boolean | null
          item_name: string
          normalized_name?: string | null
          quantity?: string | null
          quantity_variants?: Json | null
          selected_variant_index?: number | null
          shopping_list_id?: string | null
          source?: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          id?: string
          is_checked?: boolean | null
          item_name?: string
          normalized_name?: string | null
          quantity?: string | null
          quantity_variants?: Json | null
          selected_variant_index?: number | null
          shopping_list_id?: string | null
          source?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_items_shopping_list_id_fkey"
            columns: ["shopping_list_id"]
            isOneToOne: false
            referencedRelation: "shopping_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      shopping_list_requests: {
        Row: {
          created_at: string | null
          end_date: string | null
          id: string
          meal_plan_id: string | null
          progress: Json | null
          result: Json | null
          shopping_list_id: string | null
          start_date: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          end_date?: string | null
          id?: string
          meal_plan_id?: string | null
          progress?: Json | null
          result?: Json | null
          shopping_list_id?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          end_date?: string | null
          id?: string
          meal_plan_id?: string | null
          progress?: Json | null
          result?: Json | null
          shopping_list_id?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_requests_shopping_list_id_fkey"
            columns: ["shopping_list_id"]
            isOneToOne: false
            referencedRelation: "shopping_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      shopping_lists: {
        Row: {
          created_at: string | null
          end_date: string
          id: string
          servings_config: Json | null
          start_date: string
          status: string | null
          title: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          end_date: string
          id?: string
          servings_config?: Json | null
          start_date: string
          status?: string | null
          title?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          end_date?: string
          id?: string
          servings_config?: Json | null
          start_date?: string
          status?: string | null
          title?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      sport_presets: {
        Row: {
          category: string
          created_at: string | null
          demand_vector: Json
          id: string
          is_team_sport: boolean | null
          is_weight_class: boolean | null
          name_en: string
          name_ja: string
          phase_descriptions: Json | null
          roles: Json
          typical_competition_duration: string | null
          updated_at: string | null
        }
        Insert: {
          category: string
          created_at?: string | null
          demand_vector: Json
          id: string
          is_team_sport?: boolean | null
          is_weight_class?: boolean | null
          name_en: string
          name_ja: string
          phase_descriptions?: Json | null
          roles?: Json
          typical_competition_duration?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          demand_vector?: Json
          id?: string
          is_team_sport?: boolean | null
          is_weight_class?: boolean | null
          name_en?: string
          name_ja?: string
          phase_descriptions?: Json | null
          roles?: Json
          typical_competition_duration?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          error_message: string | null
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          processing_status: string
          received_at: string
        }
        Insert: {
          error_message?: string | null
          event_type: string
          id: string
          payload: Json
          processed_at?: string | null
          processing_status?: string
          received_at?: string
        }
        Update: {
          error_message?: string | null
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          processing_status?: string
          received_at?: string
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          auto_renew_default: boolean
          banner_url: string | null
          created_at: string
          currency: string
          description: string | null
          display_name: string
          display_order: number
          ends_at: string | null
          feature_packages: string[]
          id: string
          max_family_seats: number | null
          max_members: number | null
          min_contract_months: number
          monthly_price_jpy: number | null
          plan_key: string
          plan_type: string
          status: string
          stripe_price_id: string | null
          stripe_product_id: string | null
          superseded_by_plan_id: string | null
          trial_days: number
          updated_at: string
          version: number
          yearly_price_jpy: number | null
        }
        Insert: {
          auto_renew_default?: boolean
          banner_url?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          display_name: string
          display_order?: number
          ends_at?: string | null
          feature_packages?: string[]
          id?: string
          max_family_seats?: number | null
          max_members?: number | null
          min_contract_months?: number
          monthly_price_jpy?: number | null
          plan_key: string
          plan_type: string
          status?: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          superseded_by_plan_id?: string | null
          trial_days?: number
          updated_at?: string
          version?: number
          yearly_price_jpy?: number | null
        }
        Update: {
          auto_renew_default?: boolean
          banner_url?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          display_name?: string
          display_order?: number
          ends_at?: string | null
          feature_packages?: string[]
          id?: string
          max_family_seats?: number | null
          max_members?: number | null
          min_contract_months?: number
          monthly_price_jpy?: number | null
          plan_key?: string
          plan_type?: string
          status?: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          superseded_by_plan_id?: string | null
          trial_days?: number
          updated_at?: string
          version?: number
          yearly_price_jpy?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_plans_superseded_by_plan_id_fkey"
            columns: ["superseded_by_plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      support_ticket_messages: {
        Row: {
          attachments: Json | null
          body: string
          created_at: string
          id: string
          is_internal: boolean
          sender_id: string
          ticket_id: string
        }
        Insert: {
          attachments?: Json | null
          body: string
          created_at?: string
          id?: string
          is_internal?: boolean
          sender_id: string
          ticket_id: string
        }
        Update: {
          attachments?: Json | null
          body?: string
          created_at?: string
          id?: string
          is_internal?: boolean
          sender_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          assignee_id: string | null
          category: string
          closed_at: string | null
          created_at: string
          first_response_at: string | null
          id: string
          organization_id: string | null
          priority: string
          resolved_at: string | null
          status: string
          subject: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assignee_id?: string | null
          category: string
          closed_at?: string | null
          created_at?: string
          first_response_at?: string | null
          id?: string
          organization_id?: string | null
          priority?: string
          resolved_at?: string | null
          status?: string
          subject: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assignee_id?: string | null
          category?: string
          closed_at?: string | null
          created_at?: string
          first_response_at?: string | null
          id?: string
          organization_id?: string | null
          priority?: string
          resolved_at?: string | null
          status?: string
          subject?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      system_daily_stats: {
        Row: {
          active_users: number | null
          ai_cost_usd: number | null
          ai_generated_meals: number | null
          ai_requests_count: number | null
          ai_tokens_used: number | null
          completed_meals: number | null
          created_at: string | null
          date: string
          dau: number | null
          error_count: number | null
          health_records_count: number | null
          id: string
          new_users: number | null
          total_planned_meals: number | null
          total_users: number | null
        }
        Insert: {
          active_users?: number | null
          ai_cost_usd?: number | null
          ai_generated_meals?: number | null
          ai_requests_count?: number | null
          ai_tokens_used?: number | null
          completed_meals?: number | null
          created_at?: string | null
          date: string
          dau?: number | null
          error_count?: number | null
          health_records_count?: number | null
          id?: string
          new_users?: number | null
          total_planned_meals?: number | null
          total_users?: number | null
        }
        Update: {
          active_users?: number | null
          ai_cost_usd?: number | null
          ai_generated_meals?: number | null
          ai_requests_count?: number | null
          ai_tokens_used?: number | null
          completed_meals?: number | null
          created_at?: string | null
          date?: string
          dau?: number | null
          error_count?: number | null
          health_records_count?: number | null
          id?: string
          new_users?: number | null
          total_planned_meals?: number | null
          total_users?: number | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          document_type: string
          document_version: string
          id: string
          ip_address: unknown
          user_agent: string | null
          user_id: string
        }
        Insert: {
          accepted_at?: string
          document_type: string
          document_version: string
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          user_id: string
        }
        Update: {
          accepted_at?: string
          document_type?: string
          document_version?: string
          id?: string
          ip_address?: unknown
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_badges: {
        Row: {
          badge_id: string
          context_json: Json | null
          message: string | null
          obtained_at: string | null
          user_id: string
        }
        Insert: {
          badge_id: string
          context_json?: Json | null
          message?: string | null
          obtained_at?: string | null
          user_id: string
        }
        Update: {
          badge_id?: string
          context_json?: Json | null
          message?: string | null
          obtained_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_badges_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "badges"
            referencedColumns: ["id"]
          },
        ]
      }
      user_daily_meals: {
        Row: {
          created_at: string | null
          day_date: string
          id: string
          is_cheat_day: boolean | null
          is_sandbox: boolean
          nutritional_focus: string | null
          source_request_id: string | null
          theme: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          day_date: string
          id?: string
          is_cheat_day?: boolean | null
          is_sandbox?: boolean
          nutritional_focus?: string | null
          source_request_id?: string | null
          theme?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          day_date?: string
          id?: string
          is_cheat_day?: boolean | null
          is_sandbox?: boolean
          nutritional_focus?: string | null
          source_request_id?: string | null
          theme?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_daily_meals_source_request_id_fkey"
            columns: ["source_request_id"]
            isOneToOne: false
            referencedRelation: "weekly_menu_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      user_metrics: {
        Row: {
          change_rate: number | null
          id: string
          metric_id: string | null
          period_end: string
          period_start: string
          period_type: string
          previous_value: number | null
          updated_at: string | null
          user_id: string | null
          value: number
        }
        Insert: {
          change_rate?: number | null
          id?: string
          metric_id?: string | null
          period_end: string
          period_start: string
          period_type: string
          previous_value?: number | null
          updated_at?: string | null
          user_id?: string | null
          value: number
        }
        Update: {
          change_rate?: number | null
          id?: string
          metric_id?: string | null
          period_end?: string
          period_start?: string
          period_type?: string
          previous_value?: number | null
          updated_at?: string | null
          user_id?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_metrics_metric_id_fkey"
            columns: ["metric_id"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_performance_checkins: {
        Row: {
          body_fat_percentage: number | null
          checkin_date: string
          created_at: string | null
          fatigue: number | null
          focus: number | null
          hunger: number | null
          id: string
          mood: number | null
          note: string | null
          resting_heart_rate: number | null
          sleep_hours: number | null
          sleep_quality: number | null
          soreness: number | null
          training_load_rpe: number | null
          training_minutes: number | null
          updated_at: string | null
          user_id: string
          weight: number | null
        }
        Insert: {
          body_fat_percentage?: number | null
          checkin_date: string
          created_at?: string | null
          fatigue?: number | null
          focus?: number | null
          hunger?: number | null
          id?: string
          mood?: number | null
          note?: string | null
          resting_heart_rate?: number | null
          sleep_hours?: number | null
          sleep_quality?: number | null
          soreness?: number | null
          training_load_rpe?: number | null
          training_minutes?: number | null
          updated_at?: string | null
          user_id: string
          weight?: number | null
        }
        Update: {
          body_fat_percentage?: number | null
          checkin_date?: string
          created_at?: string | null
          fatigue?: number | null
          focus?: number | null
          hunger?: number | null
          id?: string
          mood?: number | null
          note?: string | null
          resting_heart_rate?: number | null
          sleep_hours?: number | null
          sleep_quality?: number | null
          soreness?: number | null
          training_load_rpe?: number | null
          training_minutes?: number | null
          updated_at?: string | null
          user_id?: string
          weight?: number | null
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          age: number | null
          age_group: string
          ai_learning_enabled: boolean | null
          alcohol_frequency: string | null
          banned_at: string | null
          banned_reason: string | null
          basal_body_temp: number | null
          body_fat_percentage: number | null
          bowel_movement: string | null
          business_trip_frequency: string | null
          caffeine_intake: string | null
          carb_cycling: boolean | null
          cheat_day_config: Json | null
          children_ages: number[] | null
          climate_sensitivity: string | null
          cold_sensitivity: boolean | null
          commute: Json | null
          competition_date: string | null
          cooking_experience: string | null
          costco_member: boolean | null
          created_at: string | null
          cuisine_preferences: Json | null
          daily_water_ml: number | null
          department: string | null
          desk_hours_per_day: number | null
          diet_flags: Json | null
          diet_style: string | null
          disliked_cooking: string[] | null
          disliked_cooking_methods: string[] | null
          entertainment_frequency: string | null
          exercise_duration_per_session: number | null
          exercise_frequency: number | null
          exercise_intensity: string | null
          exercise_types: string[] | null
          family_config: Json | null
          family_id: string | null
          family_size: number | null
          favorite_dishes: string[] | null
          favorite_ingredients: string[] | null
          fitness_goals: string[] | null
          freezer_capacity: string | null
          frozen_at: string | null
          frozen_by: string | null
          frozen_reason: string | null
          gender: string
          goal_text: string | null
          gym_member: boolean | null
          handson_tour_completed_at: string | null
          handson_tour_skipped_at: string | null
          has_children: boolean | null
          has_elderly: boolean | null
          health_checkup_guidance: Json | null
          health_checkup_results: Json | null
          health_conditions: string[] | null
          height: number | null
          hobbies: string[] | null
          household_members: Json | null
          id: string
          industry: string | null
          is_active_in_org: boolean
          is_banned: boolean | null
          joined_org_at: string | null
          kitchen_appliances: string[] | null
          last_login_at: string | null
          last_profile_update: string | null
          lifestyle: Json | null
          login_count: number | null
          meal_prep_ok: boolean | null
          meal_times: Json | null
          meal_timing_preference: string | null
          medications: string[] | null
          menopause: boolean | null
          muscle_mass: number | null
          nickname: string
          nutrition_goal: string | null
          occupation: string | null
          onboarding_completed_at: string | null
          onboarding_progress: Json | null
          onboarding_started_at: string | null
          online_grocery: boolean | null
          org_role: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference: string | null
          organization_id: string | null
          outdoor_activities: string[] | null
          overtime_frequency: string | null
          perf_modes: string[] | null
          performance_profile: Json | null
          personal_trainer: boolean | null
          pets: string[] | null
          plan_key_cached: string | null
          preferred_stores: string[] | null
          pregnancy_status: string | null
          presentation_importance: string | null
          profile_completeness: number | null
          radar_chart_nutrients: string[] | null
          region: string | null
          religious_restrictions: string | null
          roles: string[] | null
          servings_config: Json | null
          shopping_frequency: string | null
          skin_condition: string | null
          sleep_quality: string | null
          sleep_time: string | null
          smoking: boolean | null
          snacking_habit: string | null
          sns_food_posting: boolean | null
          specialty_cuisines: string[] | null
          sports_activities: Json | null
          stress_level: string | null
          supplement_use: string[] | null
          swelling_prone: boolean | null
          target_body_fat: number | null
          target_date: string | null
          target_weight: number | null
          taste_preferences: Json | null
          temperature_preference: string | null
          texture_preferences: string[] | null
          travel_frequency: string | null
          updated_at: string | null
          wake_time: string | null
          water_cutting: boolean | null
          week_start_day: string | null
          weekday_cooking_minutes: number | null
          weekend_activity: string | null
          weekend_cooking_minutes: number | null
          weekly_exercise_minutes: number | null
          weekly_food_budget: number | null
          weight: number | null
          weight_change_rate: string | null
          work_hours: Json | null
          work_style: string | null
        }
        Insert: {
          age?: number | null
          age_group: string
          ai_learning_enabled?: boolean | null
          alcohol_frequency?: string | null
          banned_at?: string | null
          banned_reason?: string | null
          basal_body_temp?: number | null
          body_fat_percentage?: number | null
          bowel_movement?: string | null
          business_trip_frequency?: string | null
          caffeine_intake?: string | null
          carb_cycling?: boolean | null
          cheat_day_config?: Json | null
          children_ages?: number[] | null
          climate_sensitivity?: string | null
          cold_sensitivity?: boolean | null
          commute?: Json | null
          competition_date?: string | null
          cooking_experience?: string | null
          costco_member?: boolean | null
          created_at?: string | null
          cuisine_preferences?: Json | null
          daily_water_ml?: number | null
          department?: string | null
          desk_hours_per_day?: number | null
          diet_flags?: Json | null
          diet_style?: string | null
          disliked_cooking?: string[] | null
          disliked_cooking_methods?: string[] | null
          entertainment_frequency?: string | null
          exercise_duration_per_session?: number | null
          exercise_frequency?: number | null
          exercise_intensity?: string | null
          exercise_types?: string[] | null
          family_config?: Json | null
          family_id?: string | null
          family_size?: number | null
          favorite_dishes?: string[] | null
          favorite_ingredients?: string[] | null
          fitness_goals?: string[] | null
          freezer_capacity?: string | null
          frozen_at?: string | null
          frozen_by?: string | null
          frozen_reason?: string | null
          gender: string
          goal_text?: string | null
          gym_member?: boolean | null
          handson_tour_completed_at?: string | null
          handson_tour_skipped_at?: string | null
          has_children?: boolean | null
          has_elderly?: boolean | null
          health_checkup_guidance?: Json | null
          health_checkup_results?: Json | null
          health_conditions?: string[] | null
          height?: number | null
          hobbies?: string[] | null
          household_members?: Json | null
          id: string
          industry?: string | null
          is_active_in_org?: boolean
          is_banned?: boolean | null
          joined_org_at?: string | null
          kitchen_appliances?: string[] | null
          last_login_at?: string | null
          last_profile_update?: string | null
          lifestyle?: Json | null
          login_count?: number | null
          meal_prep_ok?: boolean | null
          meal_times?: Json | null
          meal_timing_preference?: string | null
          medications?: string[] | null
          menopause?: boolean | null
          muscle_mass?: number | null
          nickname: string
          nutrition_goal?: string | null
          occupation?: string | null
          onboarding_completed_at?: string | null
          onboarding_progress?: Json | null
          onboarding_started_at?: string | null
          online_grocery?: boolean | null
          org_role?: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference?: string | null
          organization_id?: string | null
          outdoor_activities?: string[] | null
          overtime_frequency?: string | null
          perf_modes?: string[] | null
          performance_profile?: Json | null
          personal_trainer?: boolean | null
          pets?: string[] | null
          plan_key_cached?: string | null
          preferred_stores?: string[] | null
          pregnancy_status?: string | null
          presentation_importance?: string | null
          profile_completeness?: number | null
          radar_chart_nutrients?: string[] | null
          region?: string | null
          religious_restrictions?: string | null
          roles?: string[] | null
          servings_config?: Json | null
          shopping_frequency?: string | null
          skin_condition?: string | null
          sleep_quality?: string | null
          sleep_time?: string | null
          smoking?: boolean | null
          snacking_habit?: string | null
          sns_food_posting?: boolean | null
          specialty_cuisines?: string[] | null
          sports_activities?: Json | null
          stress_level?: string | null
          supplement_use?: string[] | null
          swelling_prone?: boolean | null
          target_body_fat?: number | null
          target_date?: string | null
          target_weight?: number | null
          taste_preferences?: Json | null
          temperature_preference?: string | null
          texture_preferences?: string[] | null
          travel_frequency?: string | null
          updated_at?: string | null
          wake_time?: string | null
          water_cutting?: boolean | null
          week_start_day?: string | null
          weekday_cooking_minutes?: number | null
          weekend_activity?: string | null
          weekend_cooking_minutes?: number | null
          weekly_exercise_minutes?: number | null
          weekly_food_budget?: number | null
          weight?: number | null
          weight_change_rate?: string | null
          work_hours?: Json | null
          work_style?: string | null
        }
        Update: {
          age?: number | null
          age_group?: string
          ai_learning_enabled?: boolean | null
          alcohol_frequency?: string | null
          banned_at?: string | null
          banned_reason?: string | null
          basal_body_temp?: number | null
          body_fat_percentage?: number | null
          bowel_movement?: string | null
          business_trip_frequency?: string | null
          caffeine_intake?: string | null
          carb_cycling?: boolean | null
          cheat_day_config?: Json | null
          children_ages?: number[] | null
          climate_sensitivity?: string | null
          cold_sensitivity?: boolean | null
          commute?: Json | null
          competition_date?: string | null
          cooking_experience?: string | null
          costco_member?: boolean | null
          created_at?: string | null
          cuisine_preferences?: Json | null
          daily_water_ml?: number | null
          department?: string | null
          desk_hours_per_day?: number | null
          diet_flags?: Json | null
          diet_style?: string | null
          disliked_cooking?: string[] | null
          disliked_cooking_methods?: string[] | null
          entertainment_frequency?: string | null
          exercise_duration_per_session?: number | null
          exercise_frequency?: number | null
          exercise_intensity?: string | null
          exercise_types?: string[] | null
          family_config?: Json | null
          family_id?: string | null
          family_size?: number | null
          favorite_dishes?: string[] | null
          favorite_ingredients?: string[] | null
          fitness_goals?: string[] | null
          freezer_capacity?: string | null
          frozen_at?: string | null
          frozen_by?: string | null
          frozen_reason?: string | null
          gender?: string
          goal_text?: string | null
          gym_member?: boolean | null
          handson_tour_completed_at?: string | null
          handson_tour_skipped_at?: string | null
          has_children?: boolean | null
          has_elderly?: boolean | null
          health_checkup_guidance?: Json | null
          health_checkup_results?: Json | null
          health_conditions?: string[] | null
          height?: number | null
          hobbies?: string[] | null
          household_members?: Json | null
          id?: string
          industry?: string | null
          is_active_in_org?: boolean
          is_banned?: boolean | null
          joined_org_at?: string | null
          kitchen_appliances?: string[] | null
          last_login_at?: string | null
          last_profile_update?: string | null
          lifestyle?: Json | null
          login_count?: number | null
          meal_prep_ok?: boolean | null
          meal_times?: Json | null
          meal_timing_preference?: string | null
          medications?: string[] | null
          menopause?: boolean | null
          muscle_mass?: number | null
          nickname?: string
          nutrition_goal?: string | null
          occupation?: string | null
          onboarding_completed_at?: string | null
          onboarding_progress?: Json | null
          onboarding_started_at?: string | null
          online_grocery?: boolean | null
          org_role?: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference?: string | null
          organization_id?: string | null
          outdoor_activities?: string[] | null
          overtime_frequency?: string | null
          perf_modes?: string[] | null
          performance_profile?: Json | null
          personal_trainer?: boolean | null
          pets?: string[] | null
          plan_key_cached?: string | null
          preferred_stores?: string[] | null
          pregnancy_status?: string | null
          presentation_importance?: string | null
          profile_completeness?: number | null
          radar_chart_nutrients?: string[] | null
          region?: string | null
          religious_restrictions?: string | null
          roles?: string[] | null
          servings_config?: Json | null
          shopping_frequency?: string | null
          skin_condition?: string | null
          sleep_quality?: string | null
          sleep_time?: string | null
          smoking?: boolean | null
          snacking_habit?: string | null
          sns_food_posting?: boolean | null
          specialty_cuisines?: string[] | null
          sports_activities?: Json | null
          stress_level?: string | null
          supplement_use?: string[] | null
          swelling_prone?: boolean | null
          target_body_fat?: number | null
          target_date?: string | null
          target_weight?: number | null
          taste_preferences?: Json | null
          temperature_preference?: string | null
          texture_preferences?: string[] | null
          travel_frequency?: string | null
          updated_at?: string | null
          wake_time?: string | null
          water_cutting?: boolean | null
          week_start_day?: string | null
          weekday_cooking_minutes?: number | null
          weekend_activity?: string | null
          weekend_cooking_minutes?: number | null
          weekly_exercise_minutes?: number | null
          weekly_food_budget?: number | null
          weight?: number | null
          weight_change_rate?: string | null
          work_hours?: Json | null
          work_style?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_push_tokens: {
        Row: {
          created_at: string
          expo_push_token: string
          id: string
          platform: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expo_push_token: string
          id?: string
          platform?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expo_push_token?: string
          id?: string
          platform?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_segment_rankings: {
        Row: {
          id: string
          metric_id: string | null
          percentile: number
          period_start: string
          period_type: string
          rank: number
          segment_id: string | null
          total_users: number
          updated_at: string | null
          user_id: string | null
          value: number
          vs_avg_rate: number | null
        }
        Insert: {
          id?: string
          metric_id?: string | null
          percentile: number
          period_start: string
          period_type: string
          rank: number
          segment_id?: string | null
          total_users: number
          updated_at?: string | null
          user_id?: string | null
          value: number
          vs_avg_rate?: number | null
        }
        Update: {
          id?: string
          metric_id?: string | null
          percentile?: number
          period_start?: string
          period_type?: string
          rank?: number
          segment_id?: string | null
          total_users?: number
          updated_at?: string | null
          user_id?: string | null
          value?: number
          vs_avg_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "user_segment_rankings_metric_id_fkey"
            columns: ["metric_id"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_segment_rankings_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segment_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sessions_metadata: {
        Row: {
          created_at: string
          device_name: string | null
          ip_address: unknown
          last_active_at: string
          revoked_at: string | null
          session_id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_name?: string | null
          ip_address?: unknown
          last_active_at?: string
          revoked_at?: string | null
          session_id: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_name?: string | null
          ip_address?: unknown
          last_active_at?: string
          revoked_at?: string | null
          session_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      weekly_menu_requests: {
        Row: {
          attempt_count: number
          constraints: Json | null
          created_at: string | null
          current_step: number | null
          detected_ingredients: Json | null
          error_message: string | null
          generated_data: Json | null
          id: string
          inventory_image_url: string | null
          mode: string | null
          prediction_result: Json | null
          progress: Json | null
          prompt: string | null
          result_json: Json | null
          start_date: string
          status: string
          target_date: string | null
          target_meal_id: string | null
          target_meal_type: string | null
          target_slots: Json | null
          updated_at: string | null
          user_id: string
          worker_acquired_at: string | null
          worker_id: string | null
        }
        Insert: {
          attempt_count?: number
          constraints?: Json | null
          created_at?: string | null
          current_step?: number | null
          detected_ingredients?: Json | null
          error_message?: string | null
          generated_data?: Json | null
          id?: string
          inventory_image_url?: string | null
          mode?: string | null
          prediction_result?: Json | null
          progress?: Json | null
          prompt?: string | null
          result_json?: Json | null
          start_date: string
          status?: string
          target_date?: string | null
          target_meal_id?: string | null
          target_meal_type?: string | null
          target_slots?: Json | null
          updated_at?: string | null
          user_id: string
          worker_acquired_at?: string | null
          worker_id?: string | null
        }
        Update: {
          attempt_count?: number
          constraints?: Json | null
          created_at?: string | null
          current_step?: number | null
          detected_ingredients?: Json | null
          error_message?: string | null
          generated_data?: Json | null
          id?: string
          inventory_image_url?: string | null
          mode?: string | null
          prediction_result?: Json | null
          progress?: Json | null
          prompt?: string | null
          result_json?: Json | null
          start_date?: string
          status?: string
          target_date?: string | null
          target_meal_id?: string | null
          target_meal_type?: string | null
          target_slots?: Json | null
          updated_at?: string | null
          user_id?: string
          worker_acquired_at?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      weekly_menus: {
        Row: {
          content: Json
          created_at: string
          id: string
          request_id: string
          start_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: Json
          created_at?: string
          id?: string
          request_id: string
          start_date: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: Json
          created_at?: string
          id?: string
          request_id?: string
          start_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_menus_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "weekly_menu_requests"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      user_consultation_history: {
        Row: {
          action_history: Json | null
          important_message_count: number | null
          key_topics: string[] | null
          message_count: number | null
          session_id: string | null
          session_started: string | null
          session_updated: string | null
          summary: string | null
          summary_generated_at: string | null
          title: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_family_invite: {
        Args: {
          p_share_health?: boolean
          p_share_meals?: boolean
          p_share_menu?: boolean
          p_token: string
        }
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_family_representative_transfer: {
        Args: { p_proposal_id: string }
        Returns: {
          created_at: string
          dissolved_at: string | null
          id: string
          member_limit: number
          name: string
          plan_key: string
          representative_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "family_groups"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_org_invite: {
        Args: { p_token: string }
        Returns: {
          age: number | null
          age_group: string
          ai_learning_enabled: boolean | null
          alcohol_frequency: string | null
          banned_at: string | null
          banned_reason: string | null
          basal_body_temp: number | null
          body_fat_percentage: number | null
          bowel_movement: string | null
          business_trip_frequency: string | null
          caffeine_intake: string | null
          carb_cycling: boolean | null
          cheat_day_config: Json | null
          children_ages: number[] | null
          climate_sensitivity: string | null
          cold_sensitivity: boolean | null
          commute: Json | null
          competition_date: string | null
          cooking_experience: string | null
          costco_member: boolean | null
          created_at: string | null
          cuisine_preferences: Json | null
          daily_water_ml: number | null
          department: string | null
          desk_hours_per_day: number | null
          diet_flags: Json | null
          diet_style: string | null
          disliked_cooking: string[] | null
          disliked_cooking_methods: string[] | null
          entertainment_frequency: string | null
          exercise_duration_per_session: number | null
          exercise_frequency: number | null
          exercise_intensity: string | null
          exercise_types: string[] | null
          family_config: Json | null
          family_id: string | null
          family_size: number | null
          favorite_dishes: string[] | null
          favorite_ingredients: string[] | null
          fitness_goals: string[] | null
          freezer_capacity: string | null
          frozen_at: string | null
          frozen_by: string | null
          frozen_reason: string | null
          gender: string
          goal_text: string | null
          gym_member: boolean | null
          handson_tour_completed_at: string | null
          handson_tour_skipped_at: string | null
          has_children: boolean | null
          has_elderly: boolean | null
          health_checkup_guidance: Json | null
          health_checkup_results: Json | null
          health_conditions: string[] | null
          height: number | null
          hobbies: string[] | null
          household_members: Json | null
          id: string
          industry: string | null
          is_active_in_org: boolean
          is_banned: boolean | null
          joined_org_at: string | null
          kitchen_appliances: string[] | null
          last_login_at: string | null
          last_profile_update: string | null
          lifestyle: Json | null
          login_count: number | null
          meal_prep_ok: boolean | null
          meal_times: Json | null
          meal_timing_preference: string | null
          medications: string[] | null
          menopause: boolean | null
          muscle_mass: number | null
          nickname: string
          nutrition_goal: string | null
          occupation: string | null
          onboarding_completed_at: string | null
          onboarding_progress: Json | null
          onboarding_started_at: string | null
          online_grocery: boolean | null
          org_role: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference: string | null
          organization_id: string | null
          outdoor_activities: string[] | null
          overtime_frequency: string | null
          perf_modes: string[] | null
          performance_profile: Json | null
          personal_trainer: boolean | null
          pets: string[] | null
          plan_key_cached: string | null
          preferred_stores: string[] | null
          pregnancy_status: string | null
          presentation_importance: string | null
          profile_completeness: number | null
          radar_chart_nutrients: string[] | null
          region: string | null
          religious_restrictions: string | null
          roles: string[] | null
          servings_config: Json | null
          shopping_frequency: string | null
          skin_condition: string | null
          sleep_quality: string | null
          sleep_time: string | null
          smoking: boolean | null
          snacking_habit: string | null
          sns_food_posting: boolean | null
          specialty_cuisines: string[] | null
          sports_activities: Json | null
          stress_level: string | null
          supplement_use: string[] | null
          swelling_prone: boolean | null
          target_body_fat: number | null
          target_date: string | null
          target_weight: number | null
          taste_preferences: Json | null
          temperature_preference: string | null
          texture_preferences: string[] | null
          travel_frequency: string | null
          updated_at: string | null
          wake_time: string | null
          water_cutting: boolean | null
          week_start_day: string | null
          weekday_cooking_minutes: number | null
          weekend_activity: string | null
          weekend_cooking_minutes: number | null
          weekly_exercise_minutes: number | null
          weekly_food_budget: number | null
          weight: number | null
          weight_change_rate: string | null
          work_hours: Json | null
          work_style: string | null
        }
        SetofOptions: {
          from: "*"
          to: "user_profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_org_owner_transfer: {
        Args: { p_proposal_id: string }
        Returns: {
          contact_email: string | null
          contact_name: string | null
          created_at: string | null
          dissolved_at: string | null
          employee_count: number | null
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          owner_id: string | null
          plan: string | null
          settings: Json | null
          status: string
          subscription_expires_at: string | null
          subscription_status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_family_child: {
        Args: {
          p_child_profile: Json
          p_display_name: string
          p_family_id: string
        }
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      can_view_user_meals: {
        Args: { p_target_user_id: string }
        Returns: boolean
      }
      claim_menu_request: {
        Args: { p_worker_id: string }
        Returns: {
          attempt_count: number
          constraints: Json | null
          created_at: string | null
          current_step: number | null
          detected_ingredients: Json | null
          error_message: string | null
          generated_data: Json | null
          id: string
          inventory_image_url: string | null
          mode: string | null
          prediction_result: Json | null
          progress: Json | null
          prompt: string | null
          result_json: Json | null
          start_date: string
          status: string
          target_date: string | null
          target_meal_id: string | null
          target_meal_type: string | null
          target_slots: Json | null
          updated_at: string | null
          user_id: string
          worker_acquired_at: string | null
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "weekly_menu_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cleanup_handson_tour_sandbox_rows: { Args: never; Returns: Json }
      cleanup_old_logs: { Args: never; Returns: undefined }
      complete_handson_tour: { Args: { p_user_id: string }; Returns: Json }
      create_family_group: {
        Args: { p_name: string; p_plan_key?: string }
        Returns: {
          created_at: string
          dissolved_at: string | null
          id: string
          member_limit: number
          name: string
          plan_key: string
          representative_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "family_groups"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_family_invite: {
        Args: {
          p_custom_message?: string
          p_email: string
          p_family_id: string
        }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          custom_message: string | null
          email: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["family_role_enum"]
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "family_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_org_invite: {
        Args: {
          p_custom_message?: string
          p_email: string
          p_organization_id: string
          p_role?: Database["public"]["Enums"]["org_role_enum"]
        }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string | null
          created_by: string | null
          custom_message: string | null
          department_id: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["org_role_enum"]
          organization_id: string | null
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "organization_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_7d_checkin_averages: {
        Args: { p_date?: string; p_user_id: string }
        Returns: {
          avg_fatigue: number
          avg_focus: number
          avg_hunger: number
          avg_sleep_hours: number
          avg_sleep_quality: number
          avg_training_rpe: number
          checkin_count: number
          total_training_minutes: number
          weight_delta: number
          weight_end: number
          weight_start: number
        }[]
      }
      get_invite_details: { Args: { p_token: string }; Returns: Json }
      invoke_catalog_import: {
        Args: { p_function_name: string }
        Returns: number
      }
      is_inactive_user: { Args: { p_user_id: string }; Returns: boolean }
      leave_family: {
        Args: never
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      leave_org: {
        Args: never
        Returns: {
          age: number | null
          age_group: string
          ai_learning_enabled: boolean | null
          alcohol_frequency: string | null
          banned_at: string | null
          banned_reason: string | null
          basal_body_temp: number | null
          body_fat_percentage: number | null
          bowel_movement: string | null
          business_trip_frequency: string | null
          caffeine_intake: string | null
          carb_cycling: boolean | null
          cheat_day_config: Json | null
          children_ages: number[] | null
          climate_sensitivity: string | null
          cold_sensitivity: boolean | null
          commute: Json | null
          competition_date: string | null
          cooking_experience: string | null
          costco_member: boolean | null
          created_at: string | null
          cuisine_preferences: Json | null
          daily_water_ml: number | null
          department: string | null
          desk_hours_per_day: number | null
          diet_flags: Json | null
          diet_style: string | null
          disliked_cooking: string[] | null
          disliked_cooking_methods: string[] | null
          entertainment_frequency: string | null
          exercise_duration_per_session: number | null
          exercise_frequency: number | null
          exercise_intensity: string | null
          exercise_types: string[] | null
          family_config: Json | null
          family_id: string | null
          family_size: number | null
          favorite_dishes: string[] | null
          favorite_ingredients: string[] | null
          fitness_goals: string[] | null
          freezer_capacity: string | null
          frozen_at: string | null
          frozen_by: string | null
          frozen_reason: string | null
          gender: string
          goal_text: string | null
          gym_member: boolean | null
          handson_tour_completed_at: string | null
          handson_tour_skipped_at: string | null
          has_children: boolean | null
          has_elderly: boolean | null
          health_checkup_guidance: Json | null
          health_checkup_results: Json | null
          health_conditions: string[] | null
          height: number | null
          hobbies: string[] | null
          household_members: Json | null
          id: string
          industry: string | null
          is_active_in_org: boolean
          is_banned: boolean | null
          joined_org_at: string | null
          kitchen_appliances: string[] | null
          last_login_at: string | null
          last_profile_update: string | null
          lifestyle: Json | null
          login_count: number | null
          meal_prep_ok: boolean | null
          meal_times: Json | null
          meal_timing_preference: string | null
          medications: string[] | null
          menopause: boolean | null
          muscle_mass: number | null
          nickname: string
          nutrition_goal: string | null
          occupation: string | null
          onboarding_completed_at: string | null
          onboarding_progress: Json | null
          onboarding_started_at: string | null
          online_grocery: boolean | null
          org_role: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference: string | null
          organization_id: string | null
          outdoor_activities: string[] | null
          overtime_frequency: string | null
          perf_modes: string[] | null
          performance_profile: Json | null
          personal_trainer: boolean | null
          pets: string[] | null
          plan_key_cached: string | null
          preferred_stores: string[] | null
          pregnancy_status: string | null
          presentation_importance: string | null
          profile_completeness: number | null
          radar_chart_nutrients: string[] | null
          region: string | null
          religious_restrictions: string | null
          roles: string[] | null
          servings_config: Json | null
          shopping_frequency: string | null
          skin_condition: string | null
          sleep_quality: string | null
          sleep_time: string | null
          smoking: boolean | null
          snacking_habit: string | null
          sns_food_posting: boolean | null
          specialty_cuisines: string[] | null
          sports_activities: Json | null
          stress_level: string | null
          supplement_use: string[] | null
          swelling_prone: boolean | null
          target_body_fat: number | null
          target_date: string | null
          target_weight: number | null
          taste_preferences: Json | null
          temperature_preference: string | null
          texture_preferences: string[] | null
          travel_frequency: string | null
          updated_at: string | null
          wake_time: string | null
          water_cutting: boolean | null
          week_start_day: string | null
          weekday_cooking_minutes: number | null
          weekend_activity: string | null
          weekend_cooking_minutes: number | null
          weekly_exercise_minutes: number | null
          weekly_food_budget: number | null
          weight: number | null
          weight_change_rate: string | null
          work_hours: Json | null
          work_style: string | null
        }
        SetofOptions: {
          from: "*"
          to: "user_profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      list_families_with_inactive_representative: {
        Args: never
        Returns: {
          family_id: string
          family_name: string
          member_count: number
          representative_email: string
          representative_user_id: string
        }[]
      }
      list_orgs_with_inactive_owner: {
        Args: never
        Returns: {
          dissolved: boolean
          member_count: number
          organization_id: string
          organization_name: string
          owner_email: string
          owner_last_sign_in: string
          owner_user_id: string
        }[]
      }
      normalize_dish_name: { Args: { name: string }; Returns: string }
      operator_force_dissolve_family: {
        Args: { p_family_id: string; p_reason: string }
        Returns: {
          created_at: string
          dissolved_at: string | null
          id: string
          member_limit: number
          name: string
          plan_key: string
          representative_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "family_groups"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      operator_force_dissolve_org: {
        Args: { p_organization_id: string; p_reason?: string }
        Returns: {
          contact_email: string | null
          contact_name: string | null
          created_at: string | null
          dissolved_at: string | null
          employee_count: number | null
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          owner_id: string | null
          plan: string | null
          settings: Json | null
          status: string
          subscription_expires_at: string | null
          subscription_status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      operator_force_owner_transfer: {
        Args: {
          p_new_owner_id: string
          p_organization_id: string
          p_reason: string
        }
        Returns: {
          contact_email: string | null
          contact_name: string | null
          created_at: string | null
          dissolved_at: string | null
          employee_count: number | null
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          owner_id: string | null
          plan: string | null
          settings: Json | null
          status: string
          subscription_expires_at: string | null
          subscription_status: string | null
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "organizations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      operator_force_representative_transfer: {
        Args: { p_family_id: string; p_new_rep_id: string; p_reason: string }
        Returns: {
          created_at: string
          dissolved_at: string | null
          id: string
          member_limit: number
          name: string
          plan_key: string
          representative_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "family_groups"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      paste_meal_to_family: {
        Args: { p_source_meal_id: string; p_target_user_ids: string[] }
        Returns: string
      }
      preview_family_invite: {
        Args: { p_token: string }
        Returns: {
          email: string
          expires_at: string
          family_id: string
          family_name: string
          role: Database["public"]["Enums"]["family_role_enum"]
        }[]
      }
      preview_org_invite: {
        Args: { p_token: string }
        Returns: {
          email: string
          expires_at: string
          organization_id: string
          organization_name: string
          role: Database["public"]["Enums"]["org_role_enum"]
        }[]
      }
      promote_child_to_user: {
        Args: { p_member_id: string; p_user_id: string }
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      propose_family_representative_transfer: {
        Args: { p_family_id: string; p_to_user_id: string }
        Returns: string
      }
      propose_org_owner_transfer: {
        Args: { p_organization_id: string; p_to_user_id: string }
        Returns: string
      }
      reject_family_invite: {
        Args: { p_token: string }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          custom_message: string | null
          email: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["family_role_enum"]
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "family_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_org_invite: {
        Args: { p_token: string }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string | null
          created_by: string | null
          custom_message: string | null
          department_id: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["org_role_enum"]
          organization_id: string | null
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "organization_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_family_member: {
        Args: { p_family_id: string; p_member_id: string }
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      remove_org_member: {
        Args: { p_organization_id: string; p_user_id: string }
        Returns: {
          age: number | null
          age_group: string
          ai_learning_enabled: boolean | null
          alcohol_frequency: string | null
          banned_at: string | null
          banned_reason: string | null
          basal_body_temp: number | null
          body_fat_percentage: number | null
          bowel_movement: string | null
          business_trip_frequency: string | null
          caffeine_intake: string | null
          carb_cycling: boolean | null
          cheat_day_config: Json | null
          children_ages: number[] | null
          climate_sensitivity: string | null
          cold_sensitivity: boolean | null
          commute: Json | null
          competition_date: string | null
          cooking_experience: string | null
          costco_member: boolean | null
          created_at: string | null
          cuisine_preferences: Json | null
          daily_water_ml: number | null
          department: string | null
          desk_hours_per_day: number | null
          diet_flags: Json | null
          diet_style: string | null
          disliked_cooking: string[] | null
          disliked_cooking_methods: string[] | null
          entertainment_frequency: string | null
          exercise_duration_per_session: number | null
          exercise_frequency: number | null
          exercise_intensity: string | null
          exercise_types: string[] | null
          family_config: Json | null
          family_id: string | null
          family_size: number | null
          favorite_dishes: string[] | null
          favorite_ingredients: string[] | null
          fitness_goals: string[] | null
          freezer_capacity: string | null
          frozen_at: string | null
          frozen_by: string | null
          frozen_reason: string | null
          gender: string
          goal_text: string | null
          gym_member: boolean | null
          handson_tour_completed_at: string | null
          handson_tour_skipped_at: string | null
          has_children: boolean | null
          has_elderly: boolean | null
          health_checkup_guidance: Json | null
          health_checkup_results: Json | null
          health_conditions: string[] | null
          height: number | null
          hobbies: string[] | null
          household_members: Json | null
          id: string
          industry: string | null
          is_active_in_org: boolean
          is_banned: boolean | null
          joined_org_at: string | null
          kitchen_appliances: string[] | null
          last_login_at: string | null
          last_profile_update: string | null
          lifestyle: Json | null
          login_count: number | null
          meal_prep_ok: boolean | null
          meal_times: Json | null
          meal_timing_preference: string | null
          medications: string[] | null
          menopause: boolean | null
          muscle_mass: number | null
          nickname: string
          nutrition_goal: string | null
          occupation: string | null
          onboarding_completed_at: string | null
          onboarding_progress: Json | null
          onboarding_started_at: string | null
          online_grocery: boolean | null
          org_role: Database["public"]["Enums"]["org_role_enum"] | null
          organic_preference: string | null
          organization_id: string | null
          outdoor_activities: string[] | null
          overtime_frequency: string | null
          perf_modes: string[] | null
          performance_profile: Json | null
          personal_trainer: boolean | null
          pets: string[] | null
          plan_key_cached: string | null
          preferred_stores: string[] | null
          pregnancy_status: string | null
          presentation_importance: string | null
          profile_completeness: number | null
          radar_chart_nutrients: string[] | null
          region: string | null
          religious_restrictions: string | null
          roles: string[] | null
          servings_config: Json | null
          shopping_frequency: string | null
          skin_condition: string | null
          sleep_quality: string | null
          sleep_time: string | null
          smoking: boolean | null
          snacking_habit: string | null
          sns_food_posting: boolean | null
          specialty_cuisines: string[] | null
          sports_activities: Json | null
          stress_level: string | null
          supplement_use: string[] | null
          swelling_prone: boolean | null
          target_body_fat: number | null
          target_date: string | null
          target_weight: number | null
          taste_preferences: Json | null
          temperature_preference: string | null
          texture_preferences: string[] | null
          travel_frequency: string | null
          updated_at: string | null
          wake_time: string | null
          water_cutting: boolean | null
          week_start_day: string | null
          weekday_cooking_minutes: number | null
          weekend_activity: string | null
          weekend_cooking_minutes: number | null
          weekly_exercise_minutes: number | null
          weekly_food_budget: number | null
          weight: number | null
          weight_change_rate: string | null
          work_hours: Json | null
          work_style: string | null
        }
        SetofOptions: {
          from: "*"
          to: "user_profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reset_e2e_test_users: { Args: never; Returns: undefined }
      revoke_family_invite: {
        Args: { p_invite_id: string }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          custom_message: string | null
          email: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["family_role_enum"]
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "family_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      revoke_org_invite: {
        Args: { p_invite_id: string }
        Returns: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string | null
          created_by: string | null
          custom_message: string | null
          department_id: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_role: Database["public"]["Enums"]["org_role_enum"]
          organization_id: string | null
          rejected_at: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: string | null
          status: string
          token: string
        }
        SetofOptions: {
          from: "*"
          to: "organization_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      search_dataset_ingredients_by_embedding: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          calories_kcal: number
          carbs_g: number
          fat_g: number
          id: string
          name: string
          protein_g: number
          salt_eq_g: number
          similarity: number
        }[]
      }
      search_ingredients_by_text_similarity: {
        Args: {
          query_name: string
          result_limit?: number
          similarity_threshold?: number
        }
        Returns: {
          calcium_mg: number
          calories_kcal: number
          carbs_g: number
          cholesterol_mg: number
          discard_rate_percent: number
          fat_g: number
          fiber_g: number
          folic_acid_ug: number
          id: string
          iodine_ug: number
          iron_mg: number
          magnesium_mg: number
          name: string
          name_norm: string
          phosphorus_mg: number
          potassium_mg: number
          protein_g: number
          salt_eq_g: number
          similarity: number
          sodium_mg: number
          vitamin_a_ug: number
          vitamin_b1_mg: number
          vitamin_b12_ug: number
          vitamin_b2_mg: number
          vitamin_b6_mg: number
          vitamin_c_mg: number
          vitamin_d_ug: number
          vitamin_e_alpha_mg: number
          vitamin_k_ug: number
          zinc_mg: number
        }[]
      }
      search_ingredients_full_by_embedding: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          alcohol_g: number
          biotin_ug: number
          calcium_mg: number
          calories_kcal: number
          carbs_g: number
          cholesterol_mg: number
          chromium_ug: number
          copper_mg: number
          discard_rate_percent: number
          fat_g: number
          fiber_g: number
          folic_acid_ug: number
          id: string
          iodine_ug: number
          iron_mg: number
          magnesium_mg: number
          manganese_mg: number
          molybdenum_ug: number
          name: string
          name_norm: string
          niacin_mg: number
          pantothenic_acid_mg: number
          phosphorus_mg: number
          potassium_mg: number
          protein_g: number
          salt_eq_g: number
          selenium_ug: number
          similarity: number
          sodium_mg: number
          vitamin_a_ug: number
          vitamin_b1_mg: number
          vitamin_b12_ug: number
          vitamin_b2_mg: number
          vitamin_b6_mg: number
          vitamin_c_mg: number
          vitamin_d_ug: number
          vitamin_e_alpha_mg: number
          vitamin_k_ug: number
          water_g: number
          zinc_mg: number
        }[]
      }
      search_menu_examples: {
        Args: {
          filter_max_sodium?: number
          filter_meal_type_hint?: string
          filter_theme_tags?: string[]
          match_count?: number
          query_embedding: string
        }
        Returns: {
          calories_kcal: number
          dishes: Json
          external_id: string
          id: string
          meal_type_hint: string
          similarity: number
          sodium_g: number
          theme_tags: string[]
          title: string
        }[]
      }
      search_recipes_hybrid: {
        Args: {
          match_count?: number
          query_embedding?: string
          query_text: string
          similarity_threshold?: number
        }
        Returns: {
          calories_kcal: number
          carbs_g: number
          combined_score: number
          external_id: string
          fat_g: number
          fiber_g: number
          id: string
          ingredients_text: string
          instructions_text: string
          name: string
          protein_g: number
          sodium_g: number
        }[]
      }
      search_recipes_with_nutrition: {
        Args: {
          query_name: string
          result_limit?: number
          similarity_threshold?: number
        }
        Returns: {
          calcium_mg: number
          calories_kcal: number
          carbs_g: number
          cholesterol_mg: number
          fat_g: number
          fiber_g: number
          folic_acid_ug: number
          id: string
          ingredients_text: string
          iodine_ug: number
          iron_mg: number
          monounsaturated_fat_g: number
          name: string
          name_norm: string
          phosphorus_mg: number
          polyunsaturated_fat_g: number
          potassium_mg: number
          protein_g: number
          saturated_fat_g: number
          similarity: number
          sodium_g: number
          source_url: string
          vitamin_a_ug: number
          vitamin_b1_mg: number
          vitamin_b12_ug: number
          vitamin_b2_mg: number
          vitamin_b6_mg: number
          vitamin_c_mg: number
          vitamin_d_ug: number
          vitamin_e_mg: number
          vitamin_k_ug: number
          zinc_mg: number
        }[]
      }
      search_similar_dataset_ingredients: {
        Args: {
          query_name: string
          result_limit?: number
          similarity_threshold?: number
        }
        Returns: {
          calories_kcal: number
          carbs_g: number
          fat_g: number
          id: string
          name: string
          protein_g: number
          salt_eq_g: number
          similarity: number
        }[]
      }
      search_similar_dataset_recipes: {
        Args: {
          query_name: string
          result_limit?: number
          similarity_threshold?: number
        }
        Returns: {
          external_id: string
          id: string
          name: string
          similarity: number
        }[]
      }
      update_my_share_settings: {
        Args: {
          p_share_health: boolean
          p_share_meals: boolean
          p_share_menu: boolean
        }
        Returns: {
          avatar_color: string
          child_profile: Json | null
          display_name: string | null
          family_id: string
          id: string
          joined_at: string
          relationship: string | null
          removed_at: string | null
          role: Database["public"]["Enums"]["family_role_enum"]
          share_health: boolean
          share_meals: boolean
          share_menu: boolean
          status: string
          tags: string[]
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      user_has_non_sandbox_activity: { Args: never; Returns: boolean }
    }
    Enums: {
      family_role_enum: "representative" | "adult" | "child"
      org_role_enum: "owner" | "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      family_role_enum: ["representative", "adult", "child"],
      org_role_enum: ["owner", "admin", "member"],
    },
  },
} as const
