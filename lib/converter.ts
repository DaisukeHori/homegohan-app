import type { 
  UserProfile, Meal, MealNutritionEstimate, WeeklyMenuRequest, 
  Announcement, OrgDailyStats, Organization, DailyActivityLog, Badge,
  MealPlan, MealPlanDay, PlannedMeal, ShoppingListItem, WeeklyMenuResult,
  FitnessGoal, WorkStyle, CookingExperience, DietStyle, Frequency, QualityLevel, StressLevel,
  TargetSlot, MenuRequestMode, MenuGenerationProgress, MealType, ShoppingFrequency,
  ServingsConfig, WeekStartDay, DailyMeal, ShoppingList, ShoppingListRequest
} from '@/types/domain';
import type { 
  DbUserProfile, DbMeal, DbMealNutritionEstimate, DbWeeklyMenuRequest, 
  DbAnnouncement, DbOrgDailyStats, DbDailyMeal, DbShoppingList, DbShoppingListRequest
} from '@/types/database';

// User Profile (Extended)
export const toUserProfile = (db: DbUserProfile): UserProfile => ({
  id: db.id,
  nickname: db.nickname,
  age: db.age,
  occupation: db.occupation,
  height: db.height,
  weight: db.weight,
  ageGroup: db.age_group as any,
  gender: db.gender as any,
  goalText: db.goal_text,
  performanceModes: (db.perf_modes as any) || [],
  lifestyle: db.lifestyle,
  dietFlags: db.diet_flags,
  role: db.role,
  organizationId: db.organization_id,
  department: db.department,
  familySize: db.family_size || 1,
  cheatDayConfig: db.cheat_day_config,
  servingsConfig: db.servings_config as ServingsConfig | null,
  weekStartDay: (db.week_start_day as WeekStartDay) || 'monday',
  radarChartNutrients: db.radar_chart_nutrients as string[] | null,
  
  // === NEW: Body Info ===
  bodyFatPercentage: db.body_fat_percentage ?? null,
  muscleMass: db.muscle_mass ?? null,
  basalBodyTemp: db.basal_body_temp ?? null,

  // === NEW: Goals ===
  targetWeight: db.target_weight ?? null,
  targetBodyFat: db.target_body_fat ?? null,
  targetDate: db.target_date ?? null,
  fitnessGoals: (db.fitness_goals as FitnessGoal[]) || [],

  // === NEW: Work & Career ===
  industry: db.industry ?? null,
  workStyle: (db.work_style as WorkStyle) ?? null,
  workHours: db.work_hours ?? null,
  overtimeFrequency: (db.overtime_frequency as Frequency) ?? null,
  commute: db.commute ?? null,
  businessTripFrequency: (db.business_trip_frequency as Frequency) ?? null,
  entertainmentFrequency: (db.entertainment_frequency as Frequency) ?? null,
  deskHoursPerDay: db.desk_hours_per_day ?? null,

  // === NEW: Sports & Exercise ===
  sportsActivities: db.sports_activities || [],
  gymMember: db.gym_member ?? false,
  personalTrainer: db.personal_trainer ?? false,
  weeklyExerciseMinutes: db.weekly_exercise_minutes ?? 0,

  // === NEW: Health & Medical ===
  healthConditions: db.health_conditions || [],
  medications: db.medications || [],
  healthCheckupResults: db.health_checkup_results ?? null,
  pregnancyStatus: db.pregnancy_status as any ?? null,
  menopause: db.menopause ?? false,
  sleepQuality: (db.sleep_quality as QualityLevel) ?? null,
  stressLevel: (db.stress_level as StressLevel) ?? null,
  bowelMovement: db.bowel_movement as any ?? null,
  skinCondition: db.skin_condition as any ?? null,
  coldSensitivity: db.cold_sensitivity ?? false,
  swellingProne: db.swelling_prone ?? false,

  // === NEW: Diet Restrictions ===
  dietStyle: (db.diet_style as DietStyle) || 'normal',
  religiousRestrictions: db.religious_restrictions as any ?? null,
  dislikedCookingMethods: db.disliked_cooking_methods || [],

  // === NEW: Lifestyle Rhythm ===
  wakeTime: db.wake_time ?? null,
  sleepTime: db.sleep_time ?? null,
  mealTimes: db.meal_times ?? null,
  snackingHabit: (db.snacking_habit as Frequency) ?? null,
  alcoholFrequency: (db.alcohol_frequency as Frequency) ?? null,
  smoking: db.smoking ?? false,
  caffeineIntake: db.caffeine_intake as any ?? null,
  dailyWaterMl: db.daily_water_ml ?? null,

  // === NEW: Cooking Environment ===
  cookingExperience: (db.cooking_experience as CookingExperience) || 'beginner',
  specialtyCuisines: db.specialty_cuisines || [],
  dislikedCooking: db.disliked_cooking || [],
  weekdayCookingMinutes: db.weekday_cooking_minutes ?? 30,
  weekendCookingMinutes: db.weekend_cooking_minutes ?? 60,
  kitchenAppliances: db.kitchen_appliances || [],
  mealPrepOk: db.meal_prep_ok ?? true,
  freezerCapacity: db.freezer_capacity as any ?? null,

  // === NEW: Budget & Shopping ===
  weeklyFoodBudget: db.weekly_food_budget ?? null,
  shoppingFrequency: db.shopping_frequency as any ?? null,
  preferredStores: db.preferred_stores || [],
  onlineGrocery: db.online_grocery ?? false,
  costcoMember: db.costco_member ?? false,
  organicPreference: db.organic_preference as any ?? null,

  // === NEW: Taste Preferences ===
  cuisinePreferences: db.cuisine_preferences ?? null,
  tastePreferences: db.taste_preferences ?? null,
  favoriteIngredients: db.favorite_ingredients || [],
  favoriteDishes: db.favorite_dishes || [],
  texturePreferences: db.texture_preferences || [],
  temperaturePreference: db.temperature_preference as any ?? null,
  presentationImportance: db.presentation_importance as any ?? null,

  // === NEW: Family ===
  householdMembers: db.household_members || [],
  hasChildren: db.has_children ?? false,
  childrenAges: db.children_ages || [],
  hasElderly: db.has_elderly ?? false,
  pets: db.pets || [],

  // === NEW: Lifestyle ===
  hobbies: db.hobbies || [],
  weekendActivity: db.weekend_activity as any ?? null,
  travelFrequency: (db.travel_frequency as Frequency) ?? null,
  outdoorActivities: db.outdoor_activities || [],
  snsFoodPosting: db.sns_food_posting ?? false,

  // === NEW: Environment ===
  region: db.region ?? null,
  climateSensitivity: db.climate_sensitivity as any ?? null,

  // === NEW: Meta ===
  profileCompleteness: db.profile_completeness ?? 0,
  lastProfileUpdate: db.last_profile_update ?? null,
  aiLearningEnabled: db.ai_learning_enabled ?? true,

  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

// Convert UserProfile (camelCase) to DB format (snake_case)
export const fromUserProfile = (profile: Partial<UserProfile>): Record<string, any> => {
  const result: Record<string, any> = {};
  
  // Basic fields
  if (profile.nickname !== undefined) result.nickname = profile.nickname;
  if (profile.age !== undefined) result.age = profile.age;
  if (profile.occupation !== undefined) result.occupation = profile.occupation;
  if (profile.height !== undefined) result.height = profile.height;
  if (profile.weight !== undefined) result.weight = profile.weight;
  if (profile.ageGroup !== undefined) result.age_group = profile.ageGroup;
  if (profile.gender !== undefined) result.gender = profile.gender;
  if (profile.goalText !== undefined) result.goal_text = profile.goalText;
  if (profile.performanceModes !== undefined) result.perf_modes = profile.performanceModes;
  if (profile.lifestyle !== undefined) result.lifestyle = profile.lifestyle;
  if (profile.dietFlags !== undefined) result.diet_flags = profile.dietFlags;
  if (profile.familySize !== undefined) result.family_size = profile.familySize;
  if (profile.cheatDayConfig !== undefined) result.cheat_day_config = profile.cheatDayConfig;
  if (profile.servingsConfig !== undefined) result.servings_config = profile.servingsConfig;
  if (profile.weekStartDay !== undefined) result.week_start_day = profile.weekStartDay;
  if (profile.radarChartNutrients !== undefined) result.radar_chart_nutrients = profile.radarChartNutrients;
  
  // Body Info
  if (profile.bodyFatPercentage !== undefined) result.body_fat_percentage = profile.bodyFatPercentage;
  if (profile.muscleMass !== undefined) result.muscle_mass = profile.muscleMass;
  if (profile.basalBodyTemp !== undefined) result.basal_body_temp = profile.basalBodyTemp;
  
  // Goals
  if (profile.targetWeight !== undefined) result.target_weight = profile.targetWeight;
  if (profile.targetBodyFat !== undefined) result.target_body_fat = profile.targetBodyFat;
  if (profile.targetDate !== undefined) result.target_date = profile.targetDate;
  if (profile.fitnessGoals !== undefined) result.fitness_goals = profile.fitnessGoals;
  
  // Work & Career
  if (profile.industry !== undefined) result.industry = profile.industry;
  if (profile.workStyle !== undefined) result.work_style = profile.workStyle;
  if (profile.workHours !== undefined) result.work_hours = profile.workHours;
  if (profile.overtimeFrequency !== undefined) result.overtime_frequency = profile.overtimeFrequency;
  if (profile.commute !== undefined) result.commute = profile.commute;
  if (profile.businessTripFrequency !== undefined) result.business_trip_frequency = profile.businessTripFrequency;
  if (profile.entertainmentFrequency !== undefined) result.entertainment_frequency = profile.entertainmentFrequency;
  if (profile.deskHoursPerDay !== undefined) result.desk_hours_per_day = profile.deskHoursPerDay;
  
  // Sports & Exercise
  if (profile.sportsActivities !== undefined) result.sports_activities = profile.sportsActivities;
  if (profile.gymMember !== undefined) result.gym_member = profile.gymMember;
  if (profile.personalTrainer !== undefined) result.personal_trainer = profile.personalTrainer;
  if (profile.weeklyExerciseMinutes !== undefined) result.weekly_exercise_minutes = profile.weeklyExerciseMinutes;
  
  // Health & Medical
  if (profile.healthConditions !== undefined) result.health_conditions = profile.healthConditions;
  if (profile.medications !== undefined) result.medications = profile.medications;
  if (profile.healthCheckupResults !== undefined) result.health_checkup_results = profile.healthCheckupResults;
  if (profile.pregnancyStatus !== undefined) result.pregnancy_status = profile.pregnancyStatus;
  if (profile.menopause !== undefined) result.menopause = profile.menopause;
  if (profile.sleepQuality !== undefined) result.sleep_quality = profile.sleepQuality;
  if (profile.stressLevel !== undefined) result.stress_level = profile.stressLevel;
  if (profile.bowelMovement !== undefined) result.bowel_movement = profile.bowelMovement;
  if (profile.skinCondition !== undefined) result.skin_condition = profile.skinCondition;
  if (profile.coldSensitivity !== undefined) result.cold_sensitivity = profile.coldSensitivity;
  if (profile.swellingProne !== undefined) result.swelling_prone = profile.swellingProne;
  
  // Diet Restrictions
  if (profile.dietStyle !== undefined) result.diet_style = profile.dietStyle;
  if (profile.religiousRestrictions !== undefined) result.religious_restrictions = profile.religiousRestrictions;
  if (profile.dislikedCookingMethods !== undefined) result.disliked_cooking_methods = profile.dislikedCookingMethods;
  
  // Lifestyle Rhythm
  if (profile.wakeTime !== undefined) result.wake_time = profile.wakeTime;
  if (profile.sleepTime !== undefined) result.sleep_time = profile.sleepTime;
  if (profile.mealTimes !== undefined) result.meal_times = profile.mealTimes;
  if (profile.snackingHabit !== undefined) result.snacking_habit = profile.snackingHabit;
  if (profile.alcoholFrequency !== undefined) result.alcohol_frequency = profile.alcoholFrequency;
  if (profile.smoking !== undefined) result.smoking = profile.smoking;
  if (profile.caffeineIntake !== undefined) result.caffeine_intake = profile.caffeineIntake;
  if (profile.dailyWaterMl !== undefined) result.daily_water_ml = profile.dailyWaterMl;
  
  // Cooking Environment
  if (profile.cookingExperience !== undefined) result.cooking_experience = profile.cookingExperience;
  if (profile.specialtyCuisines !== undefined) result.specialty_cuisines = profile.specialtyCuisines;
  if (profile.dislikedCooking !== undefined) result.disliked_cooking = profile.dislikedCooking;
  if (profile.weekdayCookingMinutes !== undefined) result.weekday_cooking_minutes = profile.weekdayCookingMinutes;
  if (profile.weekendCookingMinutes !== undefined) result.weekend_cooking_minutes = profile.weekendCookingMinutes;
  if (profile.kitchenAppliances !== undefined) result.kitchen_appliances = profile.kitchenAppliances;
  if (profile.mealPrepOk !== undefined) result.meal_prep_ok = profile.mealPrepOk;
  if (profile.freezerCapacity !== undefined) result.freezer_capacity = profile.freezerCapacity;
  
  // Budget & Shopping
  if (profile.weeklyFoodBudget !== undefined) result.weekly_food_budget = profile.weeklyFoodBudget;
  if (profile.shoppingFrequency !== undefined) result.shopping_frequency = profile.shoppingFrequency;
  if (profile.preferredStores !== undefined) result.preferred_stores = profile.preferredStores;
  if (profile.onlineGrocery !== undefined) result.online_grocery = profile.onlineGrocery;
  if (profile.costcoMember !== undefined) result.costco_member = profile.costcoMember;
  if (profile.organicPreference !== undefined) result.organic_preference = profile.organicPreference;
  
  // Taste Preferences
  if (profile.cuisinePreferences !== undefined) result.cuisine_preferences = profile.cuisinePreferences;
  if (profile.tastePreferences !== undefined) result.taste_preferences = profile.tastePreferences;
  if (profile.favoriteIngredients !== undefined) result.favorite_ingredients = profile.favoriteIngredients;
  if (profile.favoriteDishes !== undefined) result.favorite_dishes = profile.favoriteDishes;
  if (profile.texturePreferences !== undefined) result.texture_preferences = profile.texturePreferences;
  if (profile.temperaturePreference !== undefined) result.temperature_preference = profile.temperaturePreference;
  if (profile.presentationImportance !== undefined) result.presentation_importance = profile.presentationImportance;
  
  // Family
  if (profile.householdMembers !== undefined) result.household_members = profile.householdMembers;
  if (profile.hasChildren !== undefined) result.has_children = profile.hasChildren;
  if (profile.childrenAges !== undefined) result.children_ages = profile.childrenAges;
  if (profile.hasElderly !== undefined) result.has_elderly = profile.hasElderly;
  if (profile.pets !== undefined) result.pets = profile.pets;
  
  // Lifestyle
  if (profile.hobbies !== undefined) result.hobbies = profile.hobbies;
  if (profile.weekendActivity !== undefined) result.weekend_activity = profile.weekendActivity;
  if (profile.travelFrequency !== undefined) result.travel_frequency = profile.travelFrequency;
  if (profile.outdoorActivities !== undefined) result.outdoor_activities = profile.outdoorActivities;
  if (profile.snsFoodPosting !== undefined) result.sns_food_posting = profile.snsFoodPosting;
  
  // Environment
  if (profile.region !== undefined) result.region = profile.region;
  if (profile.climateSensitivity !== undefined) result.climate_sensitivity = profile.climateSensitivity;
  
  // Meta
  if (profile.profileCompleteness !== undefined) result.profile_completeness = profile.profileCompleteness;
  if (profile.lastProfileUpdate !== undefined) result.last_profile_update = profile.lastProfileUpdate;
  if (profile.aiLearningEnabled !== undefined) result.ai_learning_enabled = profile.aiLearningEnabled;
  
  return result;
};

// Meal
export const toMeal = (db: DbMeal): Meal => ({
  id: db.id,
  userId: db.user_id,
  eatenAt: db.eaten_at,
  mealType: db.meal_type as any,
  photoUrl: db.photo_url,
  memo: db.memo,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

// Nutrition
export const toMealNutritionEstimate = (db: DbMealNutritionEstimate): MealNutritionEstimate => ({
  id: db.id,
  mealId: db.meal_id,
  energyKcal: db.energy_kcal,
  proteinG: db.protein_g,
  fatG: db.fat_g,
  carbsG: db.carbs_g,
  vegScore: db.veg_score,
  qualityTags: db.quality_tags || [],
  rawJson: db.raw_json,
  createdAt: db.created_at,
});

// Weekly Menu Request
export const toWeeklyMenuRequest = (db: DbWeeklyMenuRequest): WeeklyMenuRequest => ({
  id: db.id,
  userId: db.user_id,
  startDate: db.start_date,
  status: db.status as any,
  prompt: db.prompt || '',
  resultJson: db.result_json,
  errorMessage: db.error_message,
  constraints: db.constraints,
  inventoryImageUrl: db.inventory_image_url,
  detectedIngredients: db.detected_ingredients,
  predictionResult: db.prediction_result,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
  
  // V3+ fields
  mode: db.mode as MenuRequestMode | null,
  targetDate: db.target_date,
  targetMealType: db.target_meal_type as MealType | null,
  targetMealId: db.target_meal_id,
  progress: db.progress as MenuGenerationProgress | null,
  generatedData: db.generated_data,
  currentStep: db.current_step,
  
  // V4 fields
  targetSlots: db.target_slots ? toTargetSlots(db.target_slots) : null,
});

// V4 TargetSlot conversion (DB snake_case -> camelCase)
export const toTargetSlots = (dbSlots: any[]): TargetSlot[] => 
  dbSlots.map(slot => ({
    date: slot.date,
    mealType: slot.meal_type as MealType,
    plannedMealId: slot.planned_meal_id,
  }));

// V4 TargetSlot conversion (camelCase -> DB snake_case)
export const fromTargetSlots = (slots: TargetSlot[]): any[] =>
  slots.map(slot => ({
    date: slot.date,
    meal_type: slot.mealType,
    planned_meal_id: slot.plannedMealId,
  }));

// Announcement
export const toAnnouncement = (db: DbAnnouncement): Announcement => ({
  id: db.id,
  title: db.title,
  content: db.content,
  isPublic: db.is_public,
  publishedAt: db.published_at,
  createdAt: db.created_at,
});

// Org Stats
export const toOrgDailyStats = (db: DbOrgDailyStats): OrgDailyStats => ({
  id: db.id,
  organizationId: db.organization_id,
  date: db.date,
  memberCount: db.member_count,
  activeMemberCount: db.active_member_count,
  breakfastRate: db.breakfast_rate,
  lateNightRate: db.late_night_rate,
  avgScore: db.avg_score,
  createdAt: db.created_at,
});

// Organization (Converted from any for now as DbOrganization is missing)
export const toOrganization = (data: any): Organization => ({
  id: data.id,
  name: data.name,
  plan: data.plan,
  createdAt: data.created_at,
});

// Activity (Converted from any for now as DbDailyActivityLog is missing)
export const toDailyActivityLog = (data: any): DailyActivityLog => ({
  id: data.id,
  userId: data.user_id,
  date: data.date,
  steps: data.steps,
  caloriesBurned: data.calories_burned,
  feeling: data.feeling,
  createdAt: data.created_at,
});

// Badge (Converted from any for now as DbBadge is missing)
export const toBadge = (data: any): Badge => ({
  id: data.id,
  code: data.code,
  name: data.name,
  description: data.description,
  conditionJson: data.condition_json,
});

// Meal Plan (Converted from DB snake_case to camelCase)
export const toMealPlan = (data: any): MealPlan => ({
  id: data.id,
  userId: data.user_id,
  title: data.title,
  startDate: data.start_date,
  endDate: data.end_date,
  status: data.status,
  isActive: data.is_active,
  sourceRequestId: data.source_request_id,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  // Joined data if available
  days: data.meal_plan_days?.map(toMealPlanDay),
  shoppingList: data.shopping_list_items?.map(toShoppingListItem),
});

export const toMealPlanDay = (data: any): MealPlanDay => ({
  id: data.id,
  mealPlanId: data.meal_plan_id,
  dayDate: data.day_date,
  dayOfWeek: data.day_of_week,
  theme: data.theme,
  nutritionalFocus: data.nutritional_focus,
  isCheatDay: data.is_cheat_day,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  // Joined data if available - sorted by display_order
  meals: data.planned_meals
    ?.map(toPlannedMeal)
    ?.sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
});

export const toPlannedMeal = (data: any): PlannedMeal => ({
  id: data.id,
  dailyMealId: data.daily_meal_id,
  mealType: data.meal_type,
  dishName: data.dish_name,
  recipeUrl: data.recipe_url,
  imageUrl: data.image_url,
  description: data.description,
  ingredients: data.ingredients || [],
  recipeSteps: data.recipe_steps || null,
  
  // 基本栄養素
  caloriesKcal: data.calories_kcal,
  proteinG: data.protein_g,
  fatG: data.fat_g,
  carbsG: data.carbs_g,
  
  // 拡張栄養素
  sodiumG: data.sodium_g ?? null,
  aminoAcidG: data.amino_acid_g ?? null,
  sugarG: data.sugar_g ?? null,
  fiberG: data.fiber_g ?? null,
  fiberSolubleG: data.fiber_soluble_g ?? null,
  fiberInsolubleG: data.fiber_insoluble_g ?? null,
  potassiumMg: data.potassium_mg ?? null,
  calciumMg: data.calcium_mg ?? null,
  magnesiumMg: data.magnesium_mg ?? null,
  phosphorusMg: data.phosphorus_mg ?? null,
  ironMg: data.iron_mg ?? null,
  zincMg: data.zinc_mg ?? null,
  iodineUg: data.iodine_ug ?? null,
  cholesterolMg: data.cholesterol_mg ?? null,
  vitaminB1Mg: data.vitamin_b1_mg ?? null,
  vitaminB2Mg: data.vitamin_b2_mg ?? null,
  vitaminCMg: data.vitamin_c_mg ?? null,
  vitaminB6Mg: data.vitamin_b6_mg ?? null,
  vitaminB12Ug: data.vitamin_b12_ug ?? null,
  folicAcidUg: data.folic_acid_ug ?? null,
  vitaminAUg: data.vitamin_a_ug ?? null,
  vitaminDUg: data.vitamin_d_ug ?? null,
  vitaminKUg: data.vitamin_k_ug ?? null,
  vitaminEMg: data.vitamin_e_mg ?? null,
  saturatedFatG: data.saturated_fat_g ?? null,
  monounsaturatedFatG: data.monounsaturated_fat_g ?? null,
  polyunsaturatedFatG: data.polyunsaturated_fat_g ?? null,
  
  isCompleted: data.is_completed,
  completedAt: data.completed_at,
  actualMealId: data.actual_meal_id,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  // Extended fields
  mode: data.mode || 'cook',
  dishes: data.dishes || null,
  isSimple: data.is_simple ?? true,
  cookingTimeMinutes: data.cooking_time_minutes,
  memo: data.memo || null,
  vegScore: data.veg_score || null,
  qualityTags: data.quality_tags || null,
  displayOrder: data.display_order ?? 0,
  isGenerating: data.is_generating ?? false,
});

export const toShoppingListItem = (data: any): ShoppingListItem => ({
  id: data.id,
  shoppingListId: data.shopping_list_id,
  category: data.category,
  itemName: data.item_name,
  quantity: data.quantity,
  isChecked: data.is_checked,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  
  // LLM正規化対応
  source: data.source ?? 'manual',
  normalizedName: data.normalized_name ?? null,
  quantityVariants: data.quantity_variants ?? [],
  selectedVariantIndex: data.selected_variant_index ?? 0,
});

// === 日付ベースモデル ===

export const toDailyMeal = (data: any): DailyMeal => ({
  id: data.id,
  userId: data.user_id,
  dayDate: data.day_date,
  theme: data.theme,
  nutritionalFocus: data.nutritional_focus,
  isCheatDay: data.is_cheat_day ?? false,
  sourceRequestId: data.source_request_id,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  // Joined data if available - sorted by display_order
  meals: data.planned_meals
    ?.map(toPlannedMeal)
    ?.sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
});

export const toShoppingList = (data: any): ShoppingList => ({
  id: data.id,
  userId: data.user_id,
  title: data.title,
  startDate: data.start_date,
  endDate: data.end_date,
  status: data.status ?? 'active',
  servingsConfig: data.servings_config,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  // Joined data if available
  items: data.shopping_list_items?.map(toShoppingListItem),
});

export const toShoppingListRequest = (data: any): ShoppingListRequest => ({
  id: data.id,
  userId: data.user_id,
  shoppingListId: data.shopping_list_id,
  status: data.status ?? 'pending',
  progress: data.progress,
  result: data.result,
  errorMessage: data.error_message,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
});
