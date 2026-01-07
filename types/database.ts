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
  family_config: any | null;
  cheat_day_config: any | null;
  servings_config: any | null;
  week_start_day: string | null;
  created_at: string;
  updated_at: string;

  // === Extended: Body Info ===
  body_fat_percentage: number | null;
  muscle_mass: number | null;
  basal_body_temp: number | null;

  // === Extended: Goals ===
  target_weight: number | null;
  target_body_fat: number | null;
  target_date: string | null;
  fitness_goals: string[] | null;

  // === Extended: Work & Career ===
  industry: string | null;
  work_style: string | null;
  work_hours: any | null;
  overtime_frequency: string | null;
  commute: any | null;
  business_trip_frequency: string | null;
  entertainment_frequency: string | null;
  desk_hours_per_day: number | null;

  // === Extended: Sports & Exercise ===
  sports_activities: any[] | null;
  gym_member: boolean | null;
  personal_trainer: boolean | null;
  weekly_exercise_minutes: number | null;

  // === Extended: Health & Medical ===
  health_conditions: string[] | null;
  medications: string[] | null;
  health_checkup_results: any | null;
  pregnancy_status: string | null;
  menopause: boolean | null;
  sleep_quality: string | null;
  stress_level: string | null;
  bowel_movement: string | null;
  skin_condition: string | null;
  cold_sensitivity: boolean | null;
  swelling_prone: boolean | null;

  // === Extended: Diet Restrictions ===
  diet_style: string | null;
  religious_restrictions: string | null;
  disliked_cooking_methods: string[] | null;

  // === Extended: Lifestyle Rhythm ===
  wake_time: string | null;
  sleep_time: string | null;
  meal_times: any | null;
  snacking_habit: string | null;
  alcohol_frequency: string | null;
  smoking: boolean | null;
  caffeine_intake: string | null;
  daily_water_ml: number | null;

  // === Extended: Cooking Environment ===
  cooking_experience: string | null;
  specialty_cuisines: string[] | null;
  disliked_cooking: string[] | null;
  weekday_cooking_minutes: number | null;
  weekend_cooking_minutes: number | null;
  kitchen_appliances: string[] | null;
  meal_prep_ok: boolean | null;
  freezer_capacity: string | null;

  // === Extended: Budget & Shopping ===
  weekly_food_budget: number | null;
  shopping_frequency: string | null;
  preferred_stores: string[] | null;
  online_grocery: boolean | null;
  costco_member: boolean | null;
  organic_preference: string | null;

  // === Extended: Taste Preferences ===
  cuisine_preferences: any | null;
  taste_preferences: any | null;
  favorite_ingredients: string[] | null;
  favorite_dishes: string[] | null;
  texture_preferences: string[] | null;
  temperature_preference: string | null;
  presentation_importance: string | null;

  // === Extended: Family ===
  household_members: any[] | null;
  has_children: boolean | null;
  children_ages: number[] | null;
  has_elderly: boolean | null;
  pets: string[] | null;

  // === Extended: Lifestyle ===
  hobbies: string[] | null;
  weekend_activity: string | null;
  travel_frequency: string | null;
  outdoor_activities: string[] | null;
  sns_food_posting: boolean | null;

  // === Extended: Environment ===
  region: string | null;
  climate_sensitivity: string | null;

  // === Extended: Meta ===
  profile_completeness: number | null;
  last_profile_update: string | null;
  ai_learning_enabled: boolean | null;
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
  prediction_result: any | null;
  created_at: string;
  updated_at: string;
  
  // V3+ fields
  mode: string | null; // 'weekly' | 'single' | 'regenerate' | 'v4'
  target_date: string | null;
  target_meal_type: string | null;
  target_meal_id: string | null;
  progress: any | null; // JSONB for progress tracking
  generated_data: any | null; // JSONB for intermediate state
  current_step: number | null;
  
  // V4 fields
  target_slots: DbTargetSlot[] | null; // V4: 生成対象スロット
}

// V4 TargetSlot type (DB format)
export interface DbTargetSlot {
  date: string;
  meal_type: string;
  planned_meal_id?: string; // 上書き対象のID（既存スロットを更新する場合のみ）
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

// === 日付ベースモデル ===

export interface DbDailyMeal {
  id: string;
  user_id: string;
  day_date: string;
  theme: string | null;
  nutritional_focus: string | null;
  is_cheat_day: boolean;
  source_request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbShoppingList {
  id: string;
  user_id: string;
  title: string | null;
  start_date: string;
  end_date: string;
  status: 'active' | 'archived';
  servings_config: any | null;
  created_at: string;
  updated_at: string;
}

export interface DbShoppingListRequest {
  id: string;
  user_id: string;
  shopping_list_id: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: { phase: string; message: string; percentage: number } | null;
  result: any | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbShoppingListItem {
  id: string;
  shopping_list_id: string;
  category: string;
  item_name: string;
  quantity: string | null;
  is_checked: boolean;
  source: 'manual' | 'generated';
  normalized_name: string | null;
  quantity_variants: any[] | null;
  selected_variant_index: number;
  created_at: string;
  updated_at: string;
}

export interface DbPlannedMeal {
  id: string;
  daily_meal_id: string;
  meal_type: string;
  dish_name: string;
  recipe_url: string | null;
  image_url: string | null;
  description: string | null;
  ingredients: string[] | null;
  recipe_steps: string[] | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  sodium_g: number | null;
  amino_acid_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  fiber_soluble_g: number | null;
  fiber_insoluble_g: number | null;
  potassium_mg: number | null;
  calcium_mg: number | null;
  magnesium_mg: number | null;
  phosphorus_mg: number | null;
  iron_mg: number | null;
  zinc_mg: number | null;
  iodine_ug: number | null;
  cholesterol_mg: number | null;
  vitamin_b1_mg: number | null;
  vitamin_b2_mg: number | null;
  vitamin_c_mg: number | null;
  vitamin_b6_mg: number | null;
  vitamin_b12_ug: number | null;
  folic_acid_ug: number | null;
  vitamin_a_ug: number | null;
  vitamin_d_ug: number | null;
  vitamin_k_ug: number | null;
  vitamin_e_mg: number | null;
  saturated_fat_g: number | null;
  monounsaturated_fat_g: number | null;
  polyunsaturated_fat_g: number | null;
  is_completed: boolean;
  completed_at: string | null;
  actual_meal_id: string | null;
  mode: string;
  dishes: any | null;
  is_simple: boolean;
  cooking_time_minutes: number | null;
  memo: string | null;
  veg_score: number | null;
  quality_tags: string[] | null;
  display_order: number;
  is_generating: boolean;
  created_at: string;
  updated_at: string;
}
