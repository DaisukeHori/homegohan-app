import type { 
  UserProfile, Meal, MealNutritionEstimate, WeeklyMenuRequest, 
  Announcement, OrgDailyStats 
} from '@/types/domain';
import type { 
  DbUserProfile, DbMeal, DbMealNutritionEstimate, DbWeeklyMenuRequest, 
  DbAnnouncement, DbOrgDailyStats 
} from '@/types/database';

// User Profile
export const toUserProfile = (db: DbUserProfile): UserProfile => ({
  id: db.id,
  nickname: db.nickname,
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

