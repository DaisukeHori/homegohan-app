// types/database.ts
// Supabase Database Schema Definitions (Snake Case)

export interface DbUserProfile {
  id: string;
  nickname: string;
  age: number | null;
  occupation: string | null;
  height: number | null;
  weight: number | null;
  age_group: string;
  gender: string;
  goal_text: string | null;
  perf_modes: string[] | null;
  lifestyle: any | null;
  diet_flags: any | null;
  role: 'user' | 'admin' | 'org_admin';
  organization_id: string | null;
  department: string | null;
  family_size: number;
  cheat_day_config: any | null;
  created_at: string;
  updated_at: string;
}

export interface DbMeal {
  id: string;
  user_id: string;
  eaten_at: string;
  meal_type: string;
  photo_url: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMealNutritionEstimate {
  id: string;
  meal_id: string;
  energy_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  veg_score: number | null;
  quality_tags: string[] | null;
  raw_json: any | null;
  created_at: string;
}

export interface DbWeeklyMenuRequest {
  id: string;
  user_id: string;
  start_date: string;
  status: string;
  prompt: string | null;
  result_json: any | null;
  error_message: string | null;
  constraints: any | null;
  inventory_image_url: string | null;
  detected_ingredients: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface DbAnnouncement {
  id: string;
  title: string;
  content: string;
  is_public: boolean;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbOrgDailyStats {
  id: string;
  organization_id: string;
  date: string;
  member_count: number;
  active_member_count: number;
  breakfast_rate: number;
  late_night_rate: number;
  avg_score: number;
  created_at: string;
}

