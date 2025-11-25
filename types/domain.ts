// types/domain.ts

export type ISODateTimeString = string;
export type ISODateString = string;

// --- Enum Types ---

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type AgeGroup =
  | 'under_18'
  | 'age_19_29'
  | 'age_30_39'
  | 'age_40_49'
  | 'age_50_plus';

export type Gender = 'male' | 'female' | 'other' | 'unspecified';

export type PerformanceMode =
  | 'sports'
  | 'physical_work'
  | 'knowledge_work'
  | 'study'
  | 'creative'
  | 'shift_work'
  | 'family_support'
  | 'longevity';

export type UserRole = 'user' | 'admin' | 'org_admin';

// --- User Profile & Settings ---

export interface LifestyleInfo {
  workStyle: 'desk' | 'stand' | 'physical' | 'shift';
  exerciseLevel: 'none' | 'light_1_2' | 'regular_3plus';
  notes?: string | null;
}

export interface DietFlags {
  allergies?: string[];
  restrictions?: string[];
  dislikes?: string[];
}

export interface CheatDayConfig {
  enabled: boolean;
  frequency: 'weekly' | 'biweekly';
  dayOfWeek: string; // 'Sunday', etc.
}

export interface UserProfile {
  id: string;
  nickname: string;
  ageGroup: AgeGroup;
  gender: Gender;
  goalText: string | null;
  performanceModes: PerformanceMode[];
  lifestyle: LifestyleInfo | null;
  dietFlags: DietFlags | null;
  
  // Extended
  role: UserRole;
  organizationId: string | null;
  department: string | null;
  familySize: number;
  cheatDayConfig: CheatDayConfig | null;

  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

// --- Meals ---

export interface Meal {
  id: string;
  userId: string;
  eatenAt: ISODateTimeString;
  mealType: MealType;
  photoUrl: string | null;
  memo: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  
  // Joined Data (Optional)
  nutrition?: MealNutritionEstimate;
  feedback?: MealAiFeedback;
}

export interface MealNutritionEstimate {
  id: string;
  mealId: string;
  energyKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  vegScore: number | null; // 0-5
  qualityTags: string[];
  rawJson: any;
  createdAt: ISODateTimeString;
}

export interface MealAiFeedback {
  id: string;
  mealId: string;
  feedbackText: string;
  adviceText: string | null;
  modelName: string;
  createdAt: ISODateTimeString;
}

// --- Weekly Menu ---

export type WeeklyMenuRequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface WeeklyMenuRequest {
  id: string;
  userId: string;
  startDate: ISODateString;
  status: WeeklyMenuRequestStatus;
  prompt: string;
  resultJson: WeeklyMenuResult | null;
  errorMessage: string | null;
  
  // Request constraints
  constraints: WeeklyMenuConstraints | null;
  inventoryImageUrl: string | null;
  detectedIngredients: string[] | null;

  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface WeeklyMenuConstraints {
  ingredients?: string[];
  expiringSoon?: string[];
  cookingTime?: { weekday: number; weekend: number };
  themes?: string[];
  familySize?: number;
  cheatDay?: string;
}

export interface WeeklyMenuResult {
  days: WeeklyMenuDay[];
  shoppingList: ShoppingCategory[];
  projectedImpact: ProjectedImpact;
}

export interface WeeklyMenuDay {
  date: ISODateString;
  dayOfWeek: string;
  isCheatDay: boolean;
  meals: DailyMealSet[];
  nutritionalAdvice: string;
}

export interface DailyMealSet {
  mealType: 'breakfast' | 'lunch' | 'dinner';
  dishes: Dish[];
}

export interface Dish {
  name: string;
  role?: string;
  description?: string;
}

export interface ShoppingCategory {
  category: string;
  items: string[];
}

export interface ProjectedImpact {
  weightChange: string;
  energyLevel: string;
  skinCondition: string;
  comment: string;
}

// --- Organization & Stats ---

export interface Organization {
  id: string;
  name: string;
  plan: 'standard' | 'premium' | 'enterprise';
  createdAt: ISODateTimeString;
}

export interface OrgDailyStats {
  id: string;
  organizationId: string;
  date: ISODateString;
  memberCount: number;
  activeMemberCount: number;
  breakfastRate: number;
  lateNightRate: number;
  avgScore: number;
  createdAt: ISODateTimeString;
}

// --- Activity & Social ---

export interface DailyActivityLog {
  id: string;
  userId: string;
  date: ISODateString;
  steps: number | null;
  caloriesBurned: number | null;
  feeling: 'good' | 'tired' | 'stress' | 'rest' | 'normal' | 'active' | string;
  createdAt: ISODateTimeString;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
  publishedAt: ISODateTimeString | null;
  createdAt: ISODateTimeString;
}

// --- Badges ---

export interface Badge {
  id: string;
  code: string;
  name: string;
  description: string;
  conditionJson: any;
}

export interface UserBadge {
  userId: string;
  badgeId: string;
  obtainedAt: ISODateTimeString;
  // Joined
  badge?: Badge;
}
