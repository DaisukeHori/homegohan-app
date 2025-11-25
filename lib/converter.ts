import type { 
  UserProfile, Meal, MealNutritionEstimate, WeeklyMenuRequest, 
  Announcement, OrgDailyStats, Organization, DailyActivityLog, Badge 
} from '@/types/domain';
import type { 
  DbUserProfile, DbMeal, DbMealNutritionEstimate, DbWeeklyMenuRequest, 
  DbAnnouncement, DbOrgDailyStats 
} from '@/types/database';

// User Profile
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
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

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
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

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
