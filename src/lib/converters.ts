import type { 
  UserProfile, Meal, MealNutritionEstimate, WeeklyMenuRequest, 
  Organization, OrgDailyStats, DailyActivityLog, Announcement, Badge 
} from '@/types/domain';

// --- User Profile ---
export function toUserProfile(data: any): UserProfile {
  return {
    id: data.id,
    nickname: data.nickname,
    ageGroup: data.age_group,
    gender: data.gender,
    goalText: data.goal_text,
    performanceModes: data.perf_modes || [],
    lifestyle: data.lifestyle,
    dietFlags: data.diet_flags,
    role: data.role,
    organizationId: data.organization_id,
    department: data.department,
    familySize: data.family_size || 1,
    cheatDayConfig: data.cheat_day_config,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// --- Meal ---
export function toMeal(data: any): Meal {
  return {
    id: data.id,
    userId: data.user_id,
    eatenAt: data.eaten_at,
    mealType: data.meal_type,
    photoUrl: data.photo_url,
    memo: data.memo,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    // joined data needs to be handled separately or passed in
    nutrition: data.meal_nutrition_estimates?.[0] ? toMealNutritionEstimate(data.meal_nutrition_estimates[0]) : undefined,
  };
}

export function toMealNutritionEstimate(data: any): MealNutritionEstimate {
  return {
    id: data.id,
    mealId: data.meal_id,
    energyKcal: Number(data.energy_kcal),
    proteinG: Number(data.protein_g),
    fatG: Number(data.fat_g),
    carbsG: Number(data.carbs_g),
    vegScore: data.veg_score,
    qualityTags: data.quality_tags || [],
    rawJson: data.raw_json,
    createdAt: data.created_at,
  };
}

// --- Weekly Menu ---
export function toWeeklyMenuRequest(data: any): WeeklyMenuRequest {
  return {
    id: data.id,
    userId: data.user_id,
    startDate: data.start_date,
    status: data.status,
    prompt: data.prompt,
    resultJson: data.result_json,
    errorMessage: data.error_message,
    constraints: data.constraints,
    inventoryImageUrl: data.inventory_image_url,
    detectedIngredients: data.detected_ingredients,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// --- Organization ---
export function toOrganization(data: any): Organization {
  return {
    id: data.id,
    name: data.name,
    plan: data.plan,
    createdAt: data.created_at,
  };
}

export function toOrgDailyStats(data: any): OrgDailyStats {
  return {
    id: data.id,
    organizationId: data.organization_id,
    date: data.date,
    memberCount: data.member_count,
    activeMemberCount: data.active_member_count,
    breakfastRate: data.breakfast_rate,
    lateNightRate: data.late_night_rate,
    avgScore: data.avg_score,
    createdAt: data.created_at,
  };
}

// --- Activity ---
export function toDailyActivityLog(data: any): DailyActivityLog {
  return {
    id: data.id,
    userId: data.user_id,
    date: data.date,
    steps: data.steps,
    caloriesBurned: data.calories_burned,
    feeling: data.feeling,
    createdAt: data.created_at,
  };
}

// --- Announcement ---
export function toAnnouncement(data: any): Announcement {
  return {
    id: data.id,
    title: data.title,
    content: data.content,
    isPublic: data.is_public,
    publishedAt: data.published_at,
    createdAt: data.created_at,
  };
}

// --- Badge ---
export function toBadge(data: any): Badge {
  return {
    id: data.id,
    code: data.code,
    name: data.name,
    description: data.description,
    conditionJson: data.condition_json,
  };
}

